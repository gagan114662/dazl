// A REQUIRED gate that failed (the sales-hiring check) is a hold that lead / domain confirmation cannot clear. Real confirmation + draft-gate functions, isolated stubbed database, no
// network, no draft sent. The control (a lead in ordinary review) is unblocked by confirmation exactly as before.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { seedOffers } from './helpers/seed-offer.ts'
import { confirmLeadReview } from '../lib/scan/review-confirm.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { setDomainReview } from '../lib/scan/domain-review-action.ts'
import { createDraft } from '../lib/outreach/service.ts'
import { currentnessHeld } from '../lib/outreach/currentness.ts'
import { requiredGateHeld, markHeldInProcess, releaseHeld } from '../lib/scan/held-state.ts'
import { migrateRunReport } from '../lib/scan/run-report.ts'

function setup() { const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db); seedOffers(db); return db }
function addLead(db: Database.Database, o: { reason: string | null; confidence?: number | null }) {
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'SaaS', location: 'London' })
  const id = randomBytes(12).toString('hex')
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare('INSERT INTO leads (id, scan_job_id, company, company_domain, contact, signal, source_url, evidence_excerpt, confidence, review_reason, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, job, 'Northside Builders', 'northside.example', 'info@northside.example', 'Northside Builders raised a seed round', 'https://news.example/a', 'Northside Builders raised a seed round', o.confidence ?? null, o.reason, 70)
  return id
}
const mark = (db: Database.Database, leadId: string) => db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', 'scan:gate', 'gate_failed', 'sales_hiring_check_failed', 'x', NULL, 'https://invalid.example/', '2026-10-28', 1)").run(randomBytes(12).toString('hex'), leadId)

test('CONTROL: a lead in ordinary review becomes draftable after the user confirms it', async () => {
  const db = setup(); const id = addLead(db, { reason: 'quote_unconfirmed' })
  assert.equal(requiredGateHeld(db, 'A', id), null); assert.throws(() => createDraft(db, 'A', id, 'Acme'), /lead_not_verified/)
  assert.equal(await confirmLeadReview(sqliteDb(db), 'A', id), true)
  assert.equal(typeof createDraft(db, 'A', id, 'Acme'), 'string', 'confirmation unblocks drafting when no required gate failed')
})

test('a lead held by the FAILED sales-hiring gate stays blocked through lead confirmation and domain confirmation', async () => {
  const db = setup(); const id = addLead(db, { reason: 'sales_hiring_check_failed' })
  assert.throws(() => createDraft(db, 'A', id, 'Acme'), /lead_not_verified|sales_hiring_check_failed/)
  assert.equal(await confirmLeadReview(sqliteDb(db), 'A', id), true, 'the user can still confirm the lead (it moves out of review)')
  assert.equal(requiredGateHeld(db, 'A', id), 'sales_hiring_check_failed', 'the reason it was confirmed FROM still holds')
  try { setDomainReview(db, 'A', id, 'confirm') } catch { /* the website confirmation may be refused for other reasons: the hold must hold either way */ }
  assert.throws(() => createDraft(db, 'A', id, 'Acme'), /sales_hiring_check_failed/, 'drafting stays blocked with the failed gate as the reason')
  assert.equal(currentnessHeld(db, 'A', id), true, 'approve / send / sequences / follow-ups use the same hold')
})

test('WRITE-REJECTED: the row still reads verified, only the gate_failed marker holds it - confirmation (lead and domain) still cannot unblock drafting', async () => {
  const db = setup(); const id = addLead(db, { reason: null, confidence: 80 })
  mark(db, id)
  assert.equal(requiredGateHeld(db, 'A', id), 'sales_hiring_check_failed')
  assert.throws(() => createDraft(db, 'A', id, 'Acme'), /sales_hiring_check_failed/, 'verified-looking row, held by the marker')
  assert.equal(await confirmLeadReview(sqliteDb(db), 'A', id), true)   // a verified row can be human-confirmed too
  try { setDomainReview(db, 'A', id, 'confirm') } catch { /* see above */ }
  assert.throws(() => createDraft(db, 'A', id, 'Acme'), /sales_hiring_check_failed/)
  assert.equal(currentnessHeld(db, 'A', id), true)
})

test('tenant scope: another tenant’s lead id is never reported held', () => {
  const db = setup(); const id = addLead(db, { reason: 'sales_hiring_check_failed' })
  assert.equal(requiredGateHeld(db, 'B', id), null)
})

test('the hold clears only when the gate RUNS AGAIN AND PASSES: a stale gate_failed marker is removed for a lead the gate passes, and a lead it does not pass keeps it', async () => {
  const { applySalesHiringGate } = await import('../lib/scan/sales-hiring-gate.ts')
  const db = setup()
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'SaaS', location: 'London' })
  const ICP = JSON.stringify({ summary: 's', where: ['London, UK'], who: ['Founder'], signals: ['announced seed funding', 'hiring sales staff'], exclude: [] })
  db.prepare("UPDATE scan_jobs SET status = 'running', query = ?, icp = ? WHERE id = ?").run('Find London UK B2B SaaS startups that announced seed funding and are hiring sales staff.', ICP, job)
  const mk = (id: string, excerpt: string) => { db.prepare("INSERT INTO leads (id, scan_job_id, company, company_domain, contact, signal, source_url, evidence_excerpt, confidence, review_reason, score, date_status) VALUES (?, ?, ?, NULL, NULL, 'raised a seed round', 'https://news.example/a', ?, 80, NULL, 80, 'verified')").run(id, job, `Co ${id}`, excerpt); mark(db, id) }
  mk('pass', 'Co pass raised a seed round in London. Co pass is hiring two account executives.')
  mk('hold', 'Co hold raised a seed round in London.')
  db.prepare("UPDATE scan_jobs SET status = 'done', verified = 2 WHERE id = ?").run(job)
  const noFetch = (async () => new Response('no', { status: 404 })) as never
  await applySalesHiringGate(db, { id: job, user_id: 'A', query: 'Find London UK B2B SaaS startups that announced seed funding and are hiring sales staff.', icp: ICP }, noFetch, {})
  assert.equal(requiredGateHeld(db, 'A', 'pass'), null, 'the gate passed this lead: its stale marker is gone')
  assert.equal(requiredGateHeld(db, 'A', 'hold'), 'sales_hiring_check_failed', 'the gate demoted the other lead (no sales proof): still held')
})

test('STANDS ALONE: the run report’s held_lead_ids (the run’s own record) holds the lead when the review write AND any marker are gone - lead and domain confirmation cannot unblock drafting', async () => {
  const db = setup(); const id = addLead(db, { reason: null, confidence: 80 })   // the row still reads verified
  const jobId = (db.prepare('SELECT scan_job_id AS j FROM leads WHERE id = ?').get(id) as { j: string }).j
  assert.equal(requiredGateHeld(db, 'A', id), null, 'nothing records a failure yet')
  migrateRunReport(db)
  db.prepare('INSERT INTO scan_run_report (job_id, attempt, report) VALUES (?, 1, ?)').run(jobId, JSON.stringify({ held_lead_ids: [id] }))
  assert.equal(requiredGateHeld(db, 'A', id), 'sales_hiring_check_failed')
  await confirmLeadReview(sqliteDb(db), 'A', id); try { setDomainReview(db, 'A', id, 'confirm') } catch { /* see above */ }
  assert.throws(() => createDraft(db, 'A', id, 'Acme'), /sales_hiring_check_failed/)
  assert.equal(currentnessHeld(db, 'A', id), true)
  // the gate running again and passing releases it
  releaseHeld(db, 'A', jobId, [id])
  assert.equal(requiredGateHeld(db, 'A', id), null)
})

test('NOTHING PERSISTED: the process remembers the held lead; a gate pass releases it', () => {
  const db = setup(); const id = addLead(db, { reason: null, confidence: 80 })
  const jobId = (db.prepare('SELECT scan_job_id AS j FROM leads WHERE id = ?').get(id) as { j: string }).j
  markHeldInProcess('A', [id])
  assert.equal(requiredGateHeld(db, 'A', id), 'sales_hiring_check_failed'); assert.equal(requiredGateHeld(db, 'B', id), null)
  assert.throws(() => createDraft(db, 'A', id, 'Acme'), /sales_hiring_check_failed/)
  releaseHeld(db, 'A', jobId, [id]); assert.equal(requiredGateHeld(db, 'A', id), null)
})

test('DURABLE across a restart: every write of the failure rejected (no review reason, no marker, no report entry) and no pass record -> a FRESH process still holds the lead through lead + domain confirmation; with a durable pass record it is draftable', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path'); const { spawnSync } = await import('node:child_process'); const { fileURLToPath } = await import('node:url')
  const dir = mkdtempSync(join(tmpdir(), 'gate-hold-'))
  try {
    const file = join(dir, 'scan.db')
    const db = new Database(file); migrateScan(db); migrateOutreach(db); migrateConnectors(db); seedOffers(db)
    const ICP = JSON.stringify({ summary: 's', where: ['London, UK'], who: ['Founder'], signals: ['announced seed funding', 'hiring sales staff'], exclude: [] })
    const mkLead = (id: string) => {
      const job = createJob(db, 'A', { business_name: 'Acme', industry: 'SaaS', location: 'London' })
      db.prepare("UPDATE scan_jobs SET status = 'running', query = ?, icp = ? WHERE id = ?").run('Find London UK B2B SaaS startups that announced seed funding and are hiring sales staff.', ICP, job)
      db.prepare('INSERT INTO leads (id, scan_job_id, company, company_domain, contact, signal, source_url, evidence_excerpt, confidence, review_reason, score, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 80, NULL, 70, ?)')
        .run(id, job, 'Northside Builders', 'northside.example', 'info@northside.example', 'raised a seed round', 'https://news.example/a', 'Northside Builders raised a seed round', Math.floor(Date.now() / 1000))
    }
    mkLead('held1'); mkLead('passed1')
    // only the lead the gate actually passed carries the durable record
    db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, 'passed1', 'A', 'scan:gate', 'gate_passed', 'sales_hiring', 'x', NULL, 'https://invalid.example/', '2026-10-28', 1)").run(randomBytes(12).toString('hex'))
    db.close()
    const run = (leadId: string) => {
      const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
      const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', './test/helpers/fresh-process-hold.mts', file, leadId], { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 60000 })
      assert.equal(r.status, 0, r.stdout + r.stderr)
      return JSON.parse(/RESULT (.*)/.exec(r.stdout)![1]) as { heldBefore: string | null; confirmed: boolean; draft?: string; draftError?: string; heldAfter: string | null }
    }
    const held = run('held1')
    assert.equal(held.heldBefore, 'sales_hiring_check_failed', 'a fresh process forgets nothing: no pass record means held'); assert.equal(held.confirmed, true)
    assert.match(held.draftError ?? '', /sales_hiring_check_failed/, JSON.stringify(held)); assert.equal(held.draft, undefined); assert.equal(held.heldAfter, 'sales_hiring_check_failed')
    const passed = run('passed1')
    assert.equal(passed.heldBefore, null); assert.equal(typeof passed.draft, 'string', `a lead with a durable pass record is draftable after confirmation: ${JSON.stringify(passed)}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
