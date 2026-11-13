// #1062: a lead held by a REQUIRED check that has not passed (the sales-hiring proof, lib/scan/held-state.ts requiredGateHeld) - including the
// DEFAULT-DENY branch, where the row reads machine-verified with no review_reason - showed as "Source-checked, not drafted" on its campaign page
// and was counted as source-checked in the page's run label, while the draft guard refused it. The page now reads the guard's own verdict on the
// Db layer (requiredGateHeldForJob), on SQLite and Postgres, and says research only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { bothEngines } from './helpers/engines.ts'
import type { Db } from '../lib/db/client.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { campaignDetail } from '../lib/outreach/campaign-detail.ts'
import { leadStatus } from '../lib/outreach/campaign-view.ts'
import { currentQual, currentRun, runStatusOf } from '../lib/run-status.ts'
import { requiredGateHeld, requiredGateHeldForJob, markHeldInProcess, releaseHeld } from '../lib/scan/held-state.ts'
import { salesHiringRequired } from '../lib/scan/sales-hiring-required.ts'
import { requestedHiringRoles, roleNeedsSourceProof } from '../lib/scan/hiring-role-match.ts'

const SALES = 'Find London UK companies hiring sales account executives.'
const SALES_ICP = JSON.stringify({ signals: ['hiring sales account executives'] })
const PLAIN = 'Find London UK startups that announced seed funding within the past 90 days.'
const PLAIN_ICP = JSON.stringify({ signals: ['announced seed funding'] })

async function job(db: Db, user: string, id: string, query: string, icp: string) {
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, icp, status, candidates, created_at) VALUES (?, ?, 'x', '(from request)', '-', ?, ?, 'running', 5, 1000)", [id, user, query, icp])
}
// machine: quote found on the cited page (confidence + excerpt), no review_reason - what the DEFAULT-DENY branch holds without a pass record.
async function lead(db: Db, jobId: string, id: string, o: { review?: string | null; machine?: boolean; confirmedFrom?: string | null } = {}) {
  const machine = o.machine ?? true
  await db.run("INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, evidence_excerpt, review_reason, human_confirmed_at, human_confirmed_from) VALUES (?, ?, ?, 'hiring an account executive', 'https://jobs.example/x', ?, ?, ?, ?, ?)",
    [id, jobId, `Co ${id}`, machine ? 80 : null, machine ? `Co ${id} is hiring an account executive` : null, o.review ?? null, o.confirmedFrom ? 5 : null, o.confirmedFrom ?? null])
}
async function gateMark(db: Db, tenant: string, leadId: string, kind: 'gate_passed' | 'gate_failed', value = 'requested_role_v1') {
  await db.run("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, ?, 'scan:gate', ?, ?, 'gate', 1, 'https://jobs.example/x', '2026-11-01', 1)",
    [`${leadId}-${kind}-${value}`, leadId, tenant, kind, value])
}

// One sales-hiring scan with every hold shape and its controls, plus another tenant's scan.
async function seed(db: Db) {
  await job(db, 'A', 'js', SALES, SALES_ICP)
  await lead(db, 'js', 'deny')                                              // machine-verified, no pass record: DEFAULT-DENY holds it
  await lead(db, 'js', 'pass'); await gateMark(db, 'A', 'pass', 'gate_passed')  // the same with a recorded pass: not held
  await lead(db, 'js', 'wrongpass'); await gateMark(db, 'A', 'wrongpass', 'gate_passed', 'sales_hiring')  // a pass for the generic check, not the requested role's: held
  await lead(db, 'js', 'failed'); await gateMark(db, 'A', 'failed', 'gate_passed'); await gateMark(db, 'A', 'failed', 'gate_failed')  // failed marker wins
  await lead(db, 'js', 'report'); await gateMark(db, 'A', 'report', 'gate_passed')  // held only by the run report below
  await lead(db, 'js', 'from', { machine: false, confirmedFrom: 'sales_hiring_check_failed' })  // confirmed OUT of the failed check
  await lead(db, 'js', 'review', { machine: false, review: 'quote_unconfirmed' })     // ordinary review: not a gate hold
  await db.run('INSERT INTO scan_run_report (job_id, attempt, report) VALUES (?, 1, ?)', ['js', JSON.stringify({ held_lead_ids: ['deny'] })])
  await db.run('INSERT INTO scan_run_report (job_id, attempt, report) VALUES (?, 2, ?)', ['js', JSON.stringify({ held_lead_ids: ['report'] })])
  await job(db, 'A', 'jp', PLAIN, PLAIN_ICP)
  await lead(db, 'jp', 'plain')                                             // a request that needs no sales-hiring proof: never default-denied
  await job(db, 'B', 'jb', SALES, SALES_ICP)
  await lead(db, 'jb', 'theirs')
}

test('#1062 fixture: the sales request needs the proof (as the requested role, requested_role_v1) and the plain one does not', () => {
  assert.equal(salesHiringRequired(SALES, SALES_ICP), true)
  assert.equal(requestedHiringRoles(SALES, SALES_ICP).some(roleNeedsSourceProof), true)
  assert.equal(salesHiringRequired(PLAIN, PLAIN_ICP), false)
})

bothEngines('#1062 campaign page: a DEFAULT-DENY gate-held lead reads research only, not "Source-checked, not drafted", and is not counted source-checked', async ({ db }) => {
  await seed(db)
  const d = (await campaignDetail(db, 'A', 'js'))!
  const by = Object.fromEntries(d.leads.map(l => [l.id, l]))
  assert.deepEqual(d.leads.filter(l => l.gate_held).map(l => l.id).sort(), ['deny', 'failed', 'from', 'report', 'wrongpass'])
  assert.equal(by.deny.review_reason, null, 'the DEFAULT-DENY lead has no review_reason: only the gate verdict can hold it')
  const research = { stage: 'research', text: 'Research only - checking the source cannot make it ready' }
  assert.deepEqual(leadStatus(by.deny, []), research)
  assert.deepEqual(leadStatus(by.report, []), research)
  assert.deepEqual(leadStatus(by.pass, []), { stage: 'qualified', text: 'Source-checked, not drafted' }, 'control: a recorded pass is not held')
  assert.deepEqual(leadStatus(by.review, []), { stage: 'review', text: 'Needs your review' }, 'control: ordinary review is unchanged')
  const q = currentQual(d.leads)
  assert.equal(q.sourceChecked, 1, 'only the lead with a recorded pass counts as source-checked')
  assert.equal(q.research, 5)
  const run = currentRun(runStatusOf({ id: 'js', status: 'done', error: null, candidates: 9, verified: 5, needs_review: 2, dropped: 2, lead_count: 7 } as never), q, SALES)
  assert.equal(run.label, '7 leads found: 1 source-checked, 0 confirmed by you, 1 needs your review, 5 research only, 0 rejected')
  // A plain request is never default-denied; another tenant's scan is not readable at all.
  assert.deepEqual((await campaignDetail(db, 'A', 'jp'))!.leads.map(l => l.gate_held), [false])
  assert.equal(await campaignDetail(db, 'A', 'jb'), null)
})

bothEngines('#1062 requiredGateHeldForJob is tenant-scoped: another tenant reading a scan id gets no lead ids', async ({ db }) => {
  await seed(db)
  assert.deepEqual([...await requiredGateHeldForJob(db, 'B', 'js')], [])
  assert.deepEqual([...await requiredGateHeldForJob(db, 'A', 'jb')], [])
  assert.deepEqual([...await requiredGateHeldForJob(db, 'B', 'jb')], ['theirs'])
})

test('#1062 parity: the campaign page batch read and the draft guard (requiredGateHeld) agree on every lead, including in-process holds and a release', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw); const db = sqliteDb(raw)
  await seed(db)
  const ids = ['deny', 'pass', 'wrongpass', 'failed', 'report', 'from', 'review']
  const agree = async (why: string) => {
    const batch = await requiredGateHeldForJob(db, 'A', 'js')
    for (const id of ids) assert.equal(batch.has(id), requiredGateHeld(raw, 'A', id) !== null, `${why}: ${id}`)
  }
  await agree('seeded')
  markHeldInProcess('A', ['pass']); await agree('held in this process')
  assert.equal((await requiredGateHeldForJob(db, 'A', 'js')).has('pass'), true)
  releaseHeld(raw, 'A', 'js', ['pass', 'report']); await agree('after a gate pass released them')
  assert.equal((await requiredGateHeldForJob(db, 'A', 'js')).has('report'), false, 'the release cleared the report entry')
})

test('#1062 query plan: the gate marker read uses the lead indexes, never a full scan of lead_enrichments', () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  const plan = (raw.prepare("EXPLAIN QUERY PLAN SELECT e.lead_id, e.kind, e.value FROM lead_enrichments e JOIN leads l ON l.id = e.lead_id WHERE l.scan_job_id = ? AND e.tenant_id = ? AND e.connector = 'scan:gate' AND e.kind IN ('gate_failed', 'gate_passed')").all('j', 'A') as { detail: string }[]).map(r => r.detail).join(' | ')
  assert.doesNotMatch(plan, /SCAN (e|lead_enrichments)\b(?! USING)/, plan)
  assert.match(plan, /lead_enrichments_lead|leads_job/, plan)
})
