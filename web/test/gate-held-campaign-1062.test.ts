// #1062: a lead held by a REQUIRED check that has not passed (the sales-hiring proof, lib/scan/held-state.ts requiredGateHeld) - including the
// DEFAULT-DENY branch, where the row reads machine-verified with no review_reason - showed as "Source-checked, not drafted" on its campaign page
// and was counted as source-checked in the page's run label, while the draft guard refused it. The page now reads the guard's own verdict on the
// Db layer (requiredGateHeldForJob), on SQLite and Postgres, and says research only.
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { bothEngines } from './helpers/engines.ts'
import type { Db } from '../lib/db/client.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { campaignDetail } from '../lib/outreach/campaign-detail.ts'
import { listCampaigns } from '../lib/outreach/campaigns.ts'
import { leadStatus, qualificationLines } from '../lib/outreach/campaign-view.ts'
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
async function lead(db: Db, jobId: string, id: string, o: { review?: string | null; machine?: boolean; confirmedFrom?: string | null; date?: string | null } = {}) {
  const machine = o.machine ?? true
  await db.run("INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, evidence_excerpt, review_reason, human_confirmed_at, human_confirmed_from, event_date) VALUES (?, ?, ?, 'hiring an account executive', 'https://jobs.example/x', ?, ?, ?, ?, ?, ?)",
    [id, jobId, `Co ${id}`, machine ? 80 : null, machine ? `Co ${id} is hiring an account executive` : null, o.review ?? null, o.confirmedFrom ? 5 : null, o.confirmedFrom ?? null, o.date ?? null])
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
  await lead(db, 'js', 'reviewheld', { machine: false, review: 'quote_unconfirmed' }); await gateMark(db, 'A', 'reviewheld', 'gate_failed')  // reviewable reason, but the gate failed
  await lead(db, 'js', 'oldreport'); await gateMark(db, 'A', 'oldreport', 'gate_passed')  // held only by an OLDER run attempt: not held
  await db.run('INSERT INTO scan_run_report (job_id, attempt, report) VALUES (?, 1, ?)', ['js', JSON.stringify({ held_lead_ids: ['oldreport'] })])
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
  assert.deepEqual(d.leads.filter(l => l.gate_held).map(l => l.id).sort(), ['deny', 'failed', 'from', 'report', 'reviewheld', 'wrongpass'])
  assert.equal(by.deny.review_reason, null, 'the DEFAULT-DENY lead has no review_reason: only the gate verdict can hold it')
  const research = { stage: 'research', text: 'Research only - checking the source cannot make it ready' }
  assert.deepEqual(leadStatus(by.deny, []), research)
  assert.deepEqual(leadStatus(by.report, []), research)
  assert.deepEqual(leadStatus(by.pass, []), { stage: 'qualified', text: 'Source-checked, not drafted' }, 'control: a recorded pass is not held')
  assert.deepEqual(leadStatus(by.review, []), { stage: 'review', text: 'Needs your review' }, 'control: ordinary review is unchanged')
  assert.deepEqual(leadStatus(by.reviewheld, []), research, 'a reviewable reason does not outrank a failed required check')
  assert.deepEqual(leadStatus(by.oldreport, []), { stage: 'qualified', text: 'Source-checked, not drafted' }, 'only the LATEST run attempt holds')
  const q = currentQual(d.leads)
  assert.equal(q.sourceChecked, 2, 'only the leads with a recorded pass (and no hold) count as source-checked')
  assert.equal(q.research, 6); assert.equal(q.needsReview, 1)
  const run = currentRun(runStatusOf({ id: 'js', status: 'done', error: null, candidates: 9, verified: 7, needs_review: 2, dropped: 0, lead_count: 9 } as never), q, SALES)
  assert.equal(run.label, '9 leads found: 2 source-checked, 0 confirmed by you, 1 needs your review, 6 research only, 0 rejected')
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
  const ids = ['deny', 'pass', 'wrongpass', 'failed', 'report', 'from', 'review', 'reviewheld', 'oldreport']
  const agree = async (why: string) => {
    const batch = await requiredGateHeldForJob(db, 'A', 'js')
    for (const id of ids) assert.equal(batch.has(id), requiredGateHeld(raw, 'A', id) !== null, `${why}: ${id}`)
  }
  await agree('seeded')
  // The Campaigns list counts the same way as the campaign page: the review lead held by the failed check is research, not review.
  const c = listCampaigns(raw, 'A').find(x => x.id === 'js')!
  assert.equal(c.qualification.needsReview, 1); assert.equal(c.qualification.research, 1, 'reviewheld: an unverified review lead held by the failed check is research (from, confirmed by you, is counted in heldResearch instead)')
  // ...and its Qualification stage says the same split as the page's run label: gate-held leads are research only, never also source-checked.
  const page = currentQual((await campaignDetail(db, 'A', 'js'))!.leads)
  const [value, detail] = qualificationLines(c.qualification, c.discovery.leads)
  assert.equal(value, `${page.sourceChecked} source-checked, ${page.confirmedByYou} confirmed by you, ${page.needsReview} to review`)
  assert.match(detail ?? '', new RegExp(`, ${page.research} research only, `))
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

test('#1062 list vs page on the OTHER holds: a lead held by the time window, one confirmed out of an uncheckable reason, and a clean one read the same on both', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw); const db = sqliteDb(raw)
  const recent = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10)
  await job(db, 'A', 'jw', PLAIN, JSON.stringify({ signals: ['announced seed funding'], window_days: 30 }))
  await lead(db, 'jw', 'undated')                                                    // machine, no usable date: the 30-day window holds it
  await lead(db, 'jw', 'counter', { machine: false, confirmedFrom: 'counterparty_signal', date: recent })  // confirmed by you OUT of someone else's customer
  await lead(db, 'jw', 'clean', { date: recent })                                    // machine, inside the window: source-checked
  await lead(db, 'jw', 'unv', { machine: false, date: recent }); await gateMark(db, 'A', 'unv', 'gate_failed')  // unverified, but a required check failed
  const d = (await campaignDetail(db, 'A', 'jw'))!
  assert.deepEqual(d.leads.map(l => [l.id, l.window_held, l.gate_held]), [['undated', true, false], ['counter', false, false], ['clean', false, false], ['unv', false, true]])
  const page = currentQual(d.leads)
  assert.deepEqual([page.sourceChecked, page.confirmedByYou, page.research, page.unverified], [1, 0, 3, 0])
  assert.deepEqual(leadStatus(d.leads[3], []), { stage: 'research', text: 'Research only - checking the source cannot make it ready' }, 'checking the source of an unverified lead cannot release a failed required check')
  const c = listCampaigns(raw, 'A').find(x => x.id === 'jw')!
  const [value, detail] = qualificationLines(c.qualification, c.discovery.leads)
  assert.equal(value, '1 source-checked, 0 confirmed by you, 0 to review')
  assert.match(detail ?? '', /, 3 research only, 0 unverified, /)
  assert.doesNotMatch(c.next.label, /unverified/, 'the list never asks to check the source of a lead a required check holds')
  // An older payload without heldResearchSourceChecked (pre-#683 stubs) never goes negative or double counts.
  assert.deepEqual(qualificationLines({ sourceChecked: 1, confirmedByYou: 0, needsReview: 0, unverified: 0, held: 0, rejected: 0 }, 1), ['1 source-checked, 0 confirmed by you, 0 to review', '0 timing not confirmed, 0 research only, 0 unverified, 0 rejected'])
})

test('#1062 qualificationLines: pure counts - none passed, a held source-checked slice, and an out-of-range slice never goes negative', () => {
  const base = { sourceChecked: 3, confirmedByYou: 2, needsReview: 1, research: 1, unverified: 0, held: 3, heldResearch: 2, heldResearchSourceChecked: 1, rejected: 0 }
  assert.deepEqual(qualificationLines(base, 7), ['2 source-checked, 1 confirmed by you, 1 to review', '1 timing not confirmed, 3 research only, 0 unverified, 0 rejected'])
  assert.deepEqual(qualificationLines({ ...base, heldResearchSourceChecked: 9 }, 7)[0], '1 source-checked, 2 confirmed by you, 1 to review', 'a slice larger than heldResearch is clamped to it')
  assert.deepEqual(qualificationLines({ ...base, rejected: 7 }, 7), ['None passed: 7 rejected'])
})

test('#1062 route seam: GET /api/leads carries gate_held and Home / Leads count a gate-held lead as research (real handler, no network)', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/scan-route-loader.mjs', '--test', './test/helpers/leads-route-gate-1062-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 1/); assert.match(r.stdout, /# fail 0/)
})
