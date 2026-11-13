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
import { previewSplit, heldReason, type PreviewLead } from '../lib/journey.ts'
import { heldState, researchCause } from '../lib/lead-state.ts'
import { reviewAction } from '../lib/scan/review-action.ts'
import { approveState } from '../lib/scan/lead-card.ts'
import { opportunityCard, type CardLead } from '../lib/scan/opportunity.ts'

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
  // the detail line stays under "None passed", as on main (Hermes-PC review at 0257cbbb / feeda320)
  assert.deepEqual(qualificationLines({ ...base, rejected: 7 }, 7), ['None passed: 7 rejected', '1 timing not confirmed, 3 research only, 0 unverified, 7 rejected'])
})

test('#1062 route seam: GET /api/leads carries gate_held and Home / Leads count a gate-held lead as research (real handler, no network)', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/scan-route-loader.mjs', '--test', './test/helpers/leads-route-gate-1062-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 1/); assert.match(r.stdout, /# fail 0/)
})

test('#1062 Home / onboarding: a lead that is otherwise READY (verified source, verified date, a fit) but gate-held is research, never an opportunity', () => {
  const ready = (o: Partial<PreviewLead> = {}): PreviewLead => ({ id: 'r', company: 'Co r', signal: 's', source_url: 'https://n.example/a', evidence_excerpt: 'q', event_date: new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10), date_status: 'verified', review_reason: null, fit: 4, intent: 4, why: 'w', icp_match: null, company_domain: 'r.example', contact: 'a@r.example', quarantined_at: null, confidence: 90, human_confirmed_at: null, ...o } as PreviewLead)
  assert.equal(heldReason(ready()), null, 'control: without the gate the lead is ready')
  assert.deepEqual(previewSplit([ready()]).opportunities.map(l => l.id), ['r'], 'control: an opportunity')
  assert.equal(heldReason(ready({ gate_held: true })), 'a required check has not passed')
  assert.deepEqual(heldState(ready({ gate_held: true })), { state: 'research', cause: 'unsupported' })
  const split = previewSplit([ready({ gate_held: true })])
  assert.deepEqual([split.opportunities.length, split.review.length, split.research.map(r => r.lead.id)], [0, 0, ['r']])
  // The Leads card: Approve is refused for the gate, not for timing or review, and says why.
  assert.equal(approveState(ready()).ok, true, 'control')
  const a = approveState(ready({ gate_held: true, review_reason: 'quote_unconfirmed', currentness_held: true }))
  assert.equal(a.ok, false); assert.match(a.ok ? '' : a.reason, /required check .* has not passed/)
  // Home's research cause for a dated lead held by BOTH the window and the gate is the gate (a wider window cannot release it).
  assert.equal(researchCause(ready({ gate_held: true, window_held: true })), 'unsupported')
  assert.equal(researchCause(ready({ window_held: true })), 'older', 'control: the window alone')
})

test('#1062 Leads review copy: a reviewable reason with a failed required check offers "Keep as research", never "it can be drafted"', () => {
  const ok = reviewAction({ review_reason: 'quote_unconfirmed' })
  assert.equal(ok.label, 'I checked the source - use it', 'control')
  const held = reviewAction({ review_reason: 'quote_unconfirmed', gate_held: true })
  assert.equal(held.label, 'Keep as research')
  assert.doesNotMatch(held.hint, /can be drafted/)
  assert.match(held.hint, /a required check \(the sales-hiring proof\) has not passed/)
  assert.doesNotMatch(held.hint, /could not run/, 'the verdict alone does not say the check never ran')
})

test('#1062 the draft guard fails CLOSED on a marker or report read error; a missing table still means nothing was marked', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw); const db = sqliteDb(raw)
  await job(db, 'A', 'jp', PLAIN, PLAIN_ICP)
  await lead(db, 'jp', 'plain')                       // a plain request: not held when every read works
  assert.equal(requiredGateHeld(raw, 'A', 'plain'), null, 'control')
  const failing = (table: string) => new Proxy(raw, { get(t, k) {
    if (k === 'prepare') return (sql: string) => { if (sql.includes(table)) throw new Error('SQLITE_IOERR: disk I/O error'); return t.prepare(sql) }
    const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v } })
  assert.equal(requiredGateHeld(failing('lead_enrichments'), 'A', 'plain'), 'sales_hiring_check_failed', 'an unreadable marker never reads as not held')
  assert.equal(requiredGateHeld(failing('scan_run_report'), 'A', 'plain'), 'sales_hiring_check_failed', 'an unreadable run report never reads as not held')
  raw.exec('DROP TABLE scan_run_report'); raw.exec('DROP TABLE lead_enrichments')
  assert.equal(requiredGateHeld(raw, 'A', 'plain'), null, 'no table: nothing was marked (older stores, partial fixtures)')
})


test('#1062 Leads list card: the next step for a gate-held lead never asks to check or review the source; Home names the gate first', () => {
  const base = { id: 'c'.repeat(24), company: 'Co c', signal: 'Hiring an account executive', source_url: 'https://jobs.example/c', evidence_excerpt: 'Co c is hiring an account executive', event_date: '2026-11-01', date_status: 'verified', review_reason: null, fit: 4, intent: 4, why: 'w', confidence: 90, human_confirmed_at: null, icp_match: null, company_domain: 'c.example', contact: null, currentness_held: false, window_held: false, enrichments: [] } as CardLead
  const now = new Date('2026-11-12T12:00:00Z')
  assert.match(opportunityCard({ ...base, review_reason: 'quote_unconfirmed' }, 'Owner', now).next, /check the source/i, 'control: an ordinary review lead is asked to check')
  for (const over of [{ review_reason: 'quote_unconfirmed' }, { currentness_held: true }, {}]) {
    const next = opportunityCard({ ...base, ...over, gate_held: true }, 'Owner', now).next
    assert.doesNotMatch(next, /check the source yourself|review the source/i, JSON.stringify(over))
    assert.match(next, /^None: a required check .* has not passed/)
  }
  // Outcomes' exception label (heldReason) names the gate, not "needs your review", when the lead also carries a review reason.
  assert.equal(heldReason({ ...base, review_reason: 'quote_unconfirmed', gate_held: true } as PreviewLead), 'a required check has not passed')
})

test('#1062 a run report body that cannot be parsed holds every lead of its scan, in the draft guard AND the campaign page (fail closed, agreeing)', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw); const db = sqliteDb(raw)
  await job(db, 'A', 'jp', PLAIN, PLAIN_ICP)
  await lead(db, 'jp', 'plain'); await lead(db, 'jp', 'rev', { machine: false, review: 'quote_unconfirmed' })
  assert.deepEqual([requiredGateHeld(raw, 'A', 'plain'), (await requiredGateHeldForJob(db, 'A', 'jp')).size], [null, 0], 'control')
  await db.run('INSERT INTO scan_run_report (job_id, attempt, report) VALUES (?, 1, ?)', ['jp', '{not json'])
  assert.equal(requiredGateHeld(raw, 'A', 'plain'), 'sales_hiring_check_failed')
  assert.equal(requiredGateHeld(raw, 'A', 'rev'), 'sales_hiring_check_failed')
  assert.deepEqual([...await requiredGateHeldForJob(db, 'A', 'jp')].sort(), ['plain', 'rev'])
  for (const body of [JSON.stringify({ held_lead_ids: 'plain' }), JSON.stringify({ held_lead_ids: { plain: true } })]) {
    await db.run('UPDATE scan_run_report SET report = ? WHERE job_id = ? AND attempt = 1', [body, 'jp'])
    assert.equal(requiredGateHeld(raw, 'A', 'plain'), 'sales_hiring_check_failed', `malformed held_lead_ids ${body} fails closed`)
    assert.ok((await requiredGateHeldForJob(db, 'A', 'jp')).has('plain'), body)
  }
  assert.equal(requiredGateHeld(raw, 'A', 'plain') !== null, true)
  await db.run('UPDATE scan_run_report SET report = ? WHERE job_id = ? AND attempt = 1', ['{not json', 'jp'])
  await db.run('INSERT INTO scan_run_report (job_id, attempt, report) VALUES (?, 2, ?)', ['jp', JSON.stringify({ held_lead_ids: [] })])
  assert.deepEqual([requiredGateHeld(raw, 'A', 'plain'), (await requiredGateHeldForJob(db, 'A', 'jp')).size], [null, 0], 'a newer readable report replaces it')
  // releaseHeld skips the unreadable attempt and still clears the readable ones (rows read in any order).
  await db.run('UPDATE scan_run_report SET report = ? WHERE job_id = ? AND attempt = 2', [JSON.stringify({ held_lead_ids: ['plain'] }), 'jp'])
  await db.run('INSERT INTO scan_run_report (job_id, attempt, report) VALUES (?, 0, ?)', ['jp', JSON.stringify({ held_lead_ids: ['plain'] })])
  assert.equal(requiredGateHeld(raw, 'A', 'plain'), 'sales_hiring_check_failed')
  releaseHeld(raw, 'A', 'jp', ['plain'])
  assert.deepEqual([requiredGateHeld(raw, 'A', 'plain'), (await requiredGateHeldForJob(db, 'A', 'jp')).has('plain')], [null, false], 'the gate pass released it despite the unreadable attempt 1')
  assert.equal((raw.prepare('SELECT report FROM scan_run_report WHERE job_id = ? AND attempt = 0').get('jp') as { report: string }).report, JSON.stringify({ held_lead_ids: [] }), 'attempt 0 (read after attempt 1) was cleared too')
})

test('#1062 partial store: with the marker and report tables missing, the batch read and the draft guard still agree; a real read error makes the campaign page fail, never render', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw); const db = sqliteDb(raw)
  await seed(db)
  const ids = ['deny', 'pass', 'wrongpass', 'failed', 'report', 'from', 'review', 'reviewheld', 'oldreport']
  const failing = new Proxy(raw, { get(t, k) {
    if (k === 'prepare') return (sql: string) => { if (sql.includes('lead_enrichments')) throw new Error('SQLITE_IOERR: disk I/O error'); return t.prepare(sql) }
    const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v } })
  await assert.rejects(campaignDetail(sqliteDb(failing), 'A', 'js'), /disk I\/O error/, 'the page answers an error, never a page calling a held lead ready')
  raw.exec('DROP TABLE scan_run_report'); raw.exec('DROP TABLE lead_enrichments')
  const batch = await requiredGateHeldForJob(db, 'A', 'js')
  for (const id of ids) assert.equal(batch.has(id), requiredGateHeld(raw, 'A', id) !== null, id)
  assert.ok(batch.has('deny') && batch.has('pass'), 'with no pass records left, DEFAULT-DENY holds every machine-verified lead of the sales request')
})

test('#1062 Leads review button: a lead held by BOTH the time window and the required check names the check; a wider window is never offered as the way out', () => {
  const now = new Date('2026-11-13T12:00:00Z')
  const R = 'Moves it to your list as confirmed by you, as research only: '
  const PASSED = 'a required check (the sales-hiring proof) has not passed, which checking the source cannot change, so it stays out of drafting.'
  const RAN = 'the required sales-hiring check could not run, which checking the source cannot change, so it stays out of drafting.'
  const cases: [Record<string, unknown>, string][] = [
    // Hermes-PC's probe (reviews at 0257cbbb / feeda320): an older event + the gate
    [{ review_reason: 'outside_window', window_held: true, gate_held: true, event_date: '2025-01-01' },
      `${R}${PASSED} Its event date is also older than the time window you asked for. Only running the scan again, with the check passing and a time window wide enough to include the event (it uses your usual scan budget), can make it usable.`],
    [{ review_reason: 'quote_unconfirmed', window_held: true, gate_held: true, event_date: '2025-01-15' },
      `${R}${PASSED} Its event date is also older than the time window you asked for. Only running the scan again, with the check passing and a time window wide enough to include the event (it uses your usual scan budget), can make it usable.`],
    // no valid date + the gate: a rescan needs a dated source too, never "the check passing" alone
    [{ review_reason: 'outside_window_undated', window_held: true, gate_held: true, event_date: null },
      `${R}${PASSED} It also has no valid event date, which a wider time window does not change. Only running the scan again, with the check passing and a source with a valid event date, can make it usable.`],
    // window hold with no date supplied (unknown)
    [{ review_reason: 'quote_unconfirmed', window_held: true, gate_held: true },
      `${R}${PASSED} It is also outside the time window you asked for. Only running the scan again, with the check passing and a time window wide enough to include the event (it uses your usual scan budget), can make it usable.`],
    // the check could not run (its stored reason) + an older event
    [{ review_reason: 'sales_hiring_check_failed', window_held: true, event_date: '2025-01-01' },
      `${R}${RAN} Its event date is also older than the time window you asked for. Only running the scan again, with the check passing and a time window wide enough to include the event (it uses your usual scan budget), can make it usable.`],
    // the check could not run + no valid date, and + a window hold with no date supplied
    [{ review_reason: 'sales_hiring_check_failed', window_held: true, event_date: null },
      `${R}${RAN} It also has no valid event date, which a wider time window does not change. Only running the scan again, with the check passing and a source with a valid event date, can make it usable.`],
    [{ review_reason: 'sales_hiring_check_failed', window_held: true },
      `${R}${RAN} It is also outside the time window you asked for. Only running the scan again, with the check passing and a time window wide enough to include the event (it uses your usual scan budget), can make it usable.`],
    // the gate alone, with a dated event: no window or date wording
    [{ review_reason: 'quote_unconfirmed', gate_held: true, event_date: '2026-11-01' },
      `${R}${PASSED} Only running the scan again, with the check passing, can make it usable.`],
    // the gate alone, no window hold, no usable date (haiku r2 R6): the date still has to be confirmed afterwards
    [{ review_reason: 'quote_unconfirmed', gate_held: true, event_date: null, window_held: false },
      `${R}${PASSED} Only running the scan again, with the check passing, can make it usable. Its event date still has to be confirmed after that.`],
    // a date that looks like one but is impossible counts as no usable date (the window gate's rule) - haiku r3
    [{ review_reason: 'quote_unconfirmed', gate_held: true, event_date: '2026-02-30', window_held: false },
      `${R}${PASSED} Only running the scan again, with the check passing, can make it usable. Its event date still has to be confirmed after that.`],
    [{ review_reason: 'quote_unconfirmed', gate_held: true, event_date: '2026-13-45', window_held: false },
      `${R}${PASSED} Only running the scan again, with the check passing, can make it usable. Its event date still has to be confirmed after that.`],
  ]
  for (const [l, hint] of cases) assert.deepEqual(reviewAction(l, now), { label: 'Keep as research', hint }, JSON.stringify(l))
  // control: the window alone still gives the window advice
  assert.match(reviewAction({ review_reason: 'outside_window', window_held: true, event_date: '2025-01-01' }, now).hint, /only a new scan with a wider window can find it as current/)
})
