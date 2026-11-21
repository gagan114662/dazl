import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { compileTargeting, describePlan, planConditions } from '../lib/scan/targeting.ts'
import { salesGateOr } from '../lib/scan/sales-hiring-required.ts'
import { requestedHiringRoles } from '../lib/scan/hiring-role-match.ts'
import { applySalesHiringGate } from '../lib/scan/sales-hiring-gate.ts'

// Runs 9697d013 / b9a34d2d: the case-1 request, verbatim. Its plan kept 2 of its 4 signals ("C1 first SDR/BDR OR C2 funding"), so a lead's own
// dated "Head of Sales" posting (Uare.ai) was held no_sales_hiring_evidence.
const Q = 'Find B2B companies (5-200 employees) doing outbound sales that show a dated buying signal in the last 45 days: hiring their first SDR/BDR or sales rep, new funding, a new Head of Sales/VP Sales, or a founder still doing sales. Buyer: Founder, CEO or Head of Sales. seller = dazl (dazl.ai): AI that finds high-intent leads and drafts reviewed cold outreach from your own Gmail.'
const ICP = JSON.stringify({ summary: 's', who: ['Founder', 'CEO', 'Head of Sales'], industries: [], sizes: ['5-200 employees'], where: [], signals: ['Hiring first SDR', 'Hiring first BDR', 'Hiring first sales rep', 'New funding in last 45 days', 'New Head of Sales hired in last 45 days', 'New VP Sales hired in last 45 days', 'Founder still doing sales'], exclude: [], window_days: 45 })

test('case 1: the plan keeps every requested signal, as one OR, each on the 45-day clock', () => {
  const p = compileTargeting(Q, ICP)
  assert.equal(p.root?.op, 'or', describePlan(p.root))
  const cs = planConditions(p.root).map(c => c.cond)
  assert.deepEqual(cs.map(c => c.kind), ['hiring', 'funding', 'hiring'])
  assert.match(cs[0].role ?? '', /SDR\/BDR/)
  assert.match(cs[2].role ?? '', /Head of Sales\/VP Sales/)
  assert.ok(cs.every(c => c.within_days === 45))
})
test('case 1: "a founder still doing sales" is not dropped silently: the plan says it is unprovable and makes it no condition', () => {
  const p = compileTargeting(Q, ICP)
  assert.ok(p.ambiguities.some(a => /founder still doing sales/i.test(a.text) && /no condition/.test(a.chosen)))
  assert.ok(!planConditions(p.root).some(c => /founder/i.test(c.cond.text)))
})
test('case 1: the requested titles are the role nouns only, each title on its own', () => {
  assert.deepEqual(requestedHiringRoles(Q, ICP).map(r => r.term), ['SDR', 'BDR', 'sales rep', 'Head of Sales', 'VP Sales'])
})
test('case 1: the sales gate reads one event branch and one hiring branch covering both hiring signals', () => {
  const or = salesGateOr(Q, ICP)
  assert.ok(or)
  assert.equal(or.event.kind, 'funding')
  assert.match(or.hiring.role ?? '', /SDR\/BDR or Head of Sales\/VP Sales/)
})

async function gate(title: string) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status='running', query=?, icp=? WHERE id=?").run(Q, ICP, jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, evidence_excerpt, confidence, score, why, event_date, event_date_proof, date_status) VALUES ('L1', ?, '', 'Uare.ai', NULL, 'hiring', 'https://job-boards.greenhouse.io/uareai/jobs/4459513009', 'Uare.ai is hiring.', 80, 80, '', '2026-11-10', 'ats_structured', 'verified')").run(jobId)
  db.prepare("UPDATE scan_jobs SET status='done', verified=1 WHERE id=?").run(jobId)
  const f = (async (u: RequestInfo | URL) => String(u) === 'https://boards-api.greenhouse.io/v1/boards/uareai/jobs/4459513009' ? new Response(JSON.stringify({ id: 4459513009, title, first_published: '2026-11-10T00:00:00Z' })) : new Response('', { status: 404 })) as typeof fetch
  const r = await applySalesHiringGate(db, { id: jobId, user_id: 'u1', query: Q, icp: ICP }, f, { now: Date.parse('2026-11-21T12:00:00Z') })
  return [r.passed, (db.prepare('SELECT review_reason FROM leads').get() as { review_reason: string | null }).review_reason]
}
test('Uare.ai (b9a34d2d): its own board-dated "Head of Sales" posting proves the new-Head-of-Sales branch', async () => {
  assert.deepEqual(await gate('Head of Sales'), [1, null])
})
test('case 1: an own posting for another role (Customer Success Manager) stays held', async () => {
  assert.deepEqual(await gate('Customer Success Manager'), [0, 'no_sales_hiring_evidence'])
})
