// Actionable yield enforces the BUYER gates before it looks at domain or contact fields: a fit-0, quarantined or excluded lead is not actionable however complete its
// contact data is. Stubbed rows, invented companies, no network. These fail on e94bad1 (which counted them) and pass now.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { classifyLeads, recordActionability } from '../lib/scan/actionable.ts'
import { failClosedBuyerFit } from '../lib/scan/buyer-fit.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, enrichmentsForLeads } from '../lib/connectors/store.ts'
import { migrateMemory, saveMemory } from '../lib/memory.ts'

const ICP = JSON.stringify({ summary: 's', who: ['Founder'], where: ['London, UK'], signals: ['announced seed funding', 'hiring sales staff'], exclude: ['agencies'] })
function seed() {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateMemory(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ?, query = ? WHERE id = ?").run(ICP, 'Find London UK B2B SaaS startups that announced seed funding and are hiring sales staff.', jobId)
  const lead = (id: string, company: string, domain: string, fit: number | null, extra = '') => {
    db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, confidence, score, fit) VALUES (?, ?, '', ?, ?, 'raised a seed round', 'https://news.example/1', 80, 80, ?)").run(id, jobId, company, domain, fit)
    if (extra) db.prepare(`UPDATE leads SET ${extra} WHERE id = ?`).run(id)
    // a complete set of domain + contact evidence on every lead: a named founder and a published mailbox on the company's own domain
    const ins = db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'u1', 'sitecrawl', ?, ?, 'x', NULL, ?, '2026-10-28', 1)")
    ins.run(`${id}p`, id, 'person', 'Jane Doe, Chief Executive Officer', `https://${domain}/team`)
    ins.run(`${id}e`, id, 'email', `hello@${domain}`, `https://${domain}/contact`)
  }
  lead('ok', 'Brightloop', 'brightloop.io', 5)
  lead('fit0', 'Fitzero', 'fitzero.io', 0)
  lead('fit3', 'Fitthree', 'fitthree.io', 3)
  lead('ungraded', 'Ungraded Labs', 'ungraded.io', null)
  lead('quar', 'Quarantined Ltd', 'quarantined.io', 5, "quarantined_at = 1, quarantine_reason = 'not a buyer'")
  lead('excl', 'Excluded Agency', 'excluded.io', 5)
  saveMemory(db, 'u1', { exclusions: ['Excluded Agency', 'blocked.example'] })
  return { db, job: { id: jobId, user_id: 'u1', query: 'Find London UK B2B SaaS startups that announced seed funding and are hiring sales staff.', icp: ICP } }
}

test('buyer gates come before domain / contact fields: fit-0, below-threshold, ungraded, quarantined and excluded leads are NOT actionable; a qualifying lead with contact still is', () => {
  const { db, job } = seed()
  const by = Object.fromEntries(classifyLeads(db, job).map(r => [r.lead_id, r]))
  assert.deepEqual([by.ok.actionable, by.ok.missing], [true, []], 'a qualifying lead with domain, founder and mailbox is actionable')
  assert.deepEqual([by.fit0.actionable, by.fit0.missing], [false, ['fit_below_threshold']])
  assert.deepEqual([by.fit3.actionable, by.fit3.missing], [false, ['fit_below_threshold']], 'fit 3 is below the 4-of-5 threshold')
  assert.deepEqual([by.ungraded.actionable, by.ungraded.missing], [false, ['not_graded']], 'an ungraded lead is not qualified')
  assert.deepEqual([by.quar.actionable, by.quar.missing], [false, ['quarantined']])
  assert.deepEqual([by.excl.actionable, by.excl.missing], [false, ['excluded']])
})

test('the summary and the card agree: only the qualifying lead counts; gated leads say why and carry no contact claim', () => {
  const { db, job } = seed()
  const y = recordActionability(db, job)
  assert.equal(y.actionable, 1); assert.equal(y.verified, 6)
  assert.deepEqual([y.missing.fit_below_threshold, y.missing.not_graded, y.missing.quarantined, y.missing.excluded], [2, 1, 1, 1])
  const row = (id: string) => (enrichmentsForLeads(db, 'u1', [id])[id] ?? []).find(e => e.connector === 'scan:actionable')!
  assert.match(row('ok').value, /^Actionable:/)
  for (const id of ['fit0', 'fit3', 'ungraded', 'quar', 'excl']) { const r = row(id); assert.match(r.value, /^Not actionable yet: /, id); assert.match(r.label ?? '', /^Not a qualified buyer/, id) }
  assert.match(row('quar').value, /quarantined/); assert.match(row('excl').value, /excluded/); assert.match(row('fit0').value, /fit below threshold/)
})

test('FAIL-CLOSED buyer fit: when the fit check itself fails, hiring leads graded >= 4 are capped below the bar, so they are not actionable', () => {
  const { db, job } = seed()
  db.prepare("UPDATE leads SET signal = 'is hiring an account executive' WHERE id IN ('ok', 'fit3')").run()
  assert.equal(failClosedBuyerFit(db, job.id, 'database is locked'), 1, 'only the hiring lead graded >= 4 (fit3 was already below the bar)')
  const by = Object.fromEntries(classifyLeads(db, job).map(r => [r.lead_id, r]))
  assert.deepEqual([by.ok.actionable, by.ok.missing], [false, ['fit_below_threshold']])
  assert.match((db.prepare("SELECT why FROM leads WHERE id = 'ok'").get() as { why: string }).why, /Buyer fit unconfirmed: the check failed \(database is locked\)/)
})
