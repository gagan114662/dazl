// The real tick route (app/api/internal/tick/route.ts) classifying what runFollowups and runSequences actually returned
// (#447 review), run by test/scheduler-tick-outcomes.test.ts through the tenant-route loader. Five synthetic tenants on
// one store, in staging mode (Gmail is the stub: nothing is sent or fetched; the network is fenced):
//   R  an active sequence with a stored sent root message and no read consent  -> sequences fail (reading_not_enabled)
//   F  autopilot and follow-ups on, mailbox and identity, operator switch off   -> follow-ups fail (not_available)
//   P  an approved sequence, tenant paused                                       -> sequences held (paused)
//   S  an approved sequence with steps 2 and 3 due                               -> sequences progress; then a cap wait
//   U  an approved sequence and an uncertain send                                -> sequences fail (uncertain_send), then held (paused)
//   N  an approved sequence whose step 1 has not gone out                         -> sequences succeed with nothing due (control)
//   W  (from tick 4) follow-ups on, two interested threads due, cap 1             -> follow-ups progress, then a cap wait
// Then three more negatives: two ticks at once, a worker that throws (its table gone), the kill switch.
// The operator switches are set in this process only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { startOAuth } from '../../lib/gmail/oauth.ts'
import { acceptReadConsent } from '../../lib/outreach/replies.ts'
import { ATTESTATIONS, CONSENT_VERSION, enable, pause } from '../../lib/outreach/autopilot.ts'
import { setFollowups } from '../../lib/outreach/followups.ts'
import { grantConsent } from '../../lib/outreach/ledger.ts'
import { approve, saveSettings } from '../../lib/outreach/service.ts'
import { approveSequence, createSequence } from '../../lib/outreach/sequences.ts'
import { createJob } from '../../lib/scan/store.ts'
import { schedulerHealth, schedulerHealthResponse, tenantFreshness, BLOCKED_AFTER_FAILURES } from '../../lib/ops/scheduler-runs.ts'
import { POST as tick } from '../../app/api/internal/tick/route.ts'
import { GET as sequencesRoute } from '../../app/api/outreach/sequences/route.ts'

process.env.DAZL_ENV = 'staging'
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
process.env.AUTOPILOT_TICK_SECRET = 'test-tick-secret'
process.env.SEQUENCES_ENABLED = '1'
delete process.env.AUTOPILOT_ENABLED; delete process.env.AUTOPILOT_KILL

const db = new Database(':memory:')
migrateAllSqlite(db)
setScanDb(db)
const now = Math.floor(Date.now() / 1000), DAY = 86400
const R = 'tenant-r-noconsent', F = 'tenant-f-followups', P = 'tenant-p-paused', S = 'tenant-s-sending', U = 'tenant-u-uncertain', N = 'tenant-n-notdue', W = 'tenant-w-warm'
const env = { DAZL_ENV: 'staging', PUBLIC_BASE_URL: 'https://staging.example.test' } as never
for (const t of [R, F, P, S, U, N, W]) db.prepare("INSERT INTO users (id, email, password_hash, salt, business_name) VALUES (?, ?, 'x', 'y', ?)").run(t, `${t}@example.test`, `${t} business`)
const mailbox = (t: string) => { startOAuth(db, t, { env }); acceptReadConsent(db, t) }
const identity = (t: string) => saveSettings(db, t, { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
// An approved three-step sequence whose step 1 went out `ago` seconds ago (a stored stub send: nothing left this process).
function sequenceFixture(t: string, ago: number, sent = true) {
  const job = createJob(db, t, { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const lead = randomBytes(12).toString('hex'), mid = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(lead, job, 'Acme', 'lead@acme.example', 'Hiring roofers', 'https://acme.example/jobs', 'Hiring roofers', 90)
  db.prepare("UPDATE leads SET human_confirmed_at = ?, human_confirmed_from = 'test_review' WHERE id = ?").run(now - ago, lead)
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body) VALUES (?, ?, ?, 'lead@acme.example', 'A quick question', 'This is a draft message for review.')").run(mid, t, lead)
  const seq = createSequence(db, t, mid)
  approveSequence(db, t, seq, id => approve(db, t, id, true))
  if (sent) db.prepare("UPDATE outreach_messages SET status = 'sent', sent_at = ?, gmail_id = ?, thread_id = ? WHERE id = ?").run(now - ago, `stub-${mid}`, `thread-${mid}`, mid)
  return seq
}
// A sent first touch whose lead replied with interest `ago` seconds ago (the thread row reply sync would have written,
// and the consent it would have granted): a warm follow-up is due.
function interestedThread(t: string, to: string, ago: number) {
  const job = createJob(db, t, { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const lead = randomBytes(12).toString('hex'), mid = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(lead, job, 'Northside', to, 'Hiring roofers', 'https://n.example/a', 'Northside is hiring', 90)
  db.prepare("UPDATE leads SET human_confirmed_at = ?, human_confirmed_from = 'test_review' WHERE id = ?").run(now - ago, lead)
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at, gmail_id, thread_id) VALUES (?, ?, ?, ?, 'Quick question', 'bodybodybodybodybodybody', 'sent', ?, ?, ?, ?)").run(mid, t, lead, to, now - ago - DAY, now - ago - DAY, 'g-' + mid, 't-' + mid)
  db.prepare('INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, last_lead_reply_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(t, 't-' + mid, lead, to, `dazl.${mid}@staging.dazl.test`, now - ago, now - ago)
  grantConsent(db, t, to, { channel: 'email', scope: 'followup', basis: 'reply_interest', evidenceRef: 'gmail:r-' + mid, now: now - ago })
  return 't-' + mid
}
// R: the reviewer's first negative, on raw rows: active sequence, sent root message, no read consent
db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at) VALUES ('m-r', ?, 'l-r', 'x@co.example', 'Subject here', 'A body long enough for the check.', 'sent', ?)").run(R, now - 4 * DAY)
db.prepare("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status) VALUES ('s-r', ?, 'l-r', 'm-r', 'x@co.example', 'active')").run(R)
// F: the reviewer's second negative: everything the tenant can switch on is on; the operator switch is off
mailbox(F); identity(F); enable(db, F, { version: CONSENT_VERSION, attestations: [...ATTESTATIONS] }); setFollowups(db, F, true)
// P, S, U: approvable sequences (mailbox, identity, read consent), then their holds
mailbox(P); identity(P); sequenceFixture(P, 100); pause(db, P, 'paused_by_user')
mailbox(S); identity(S); const seqS = sequenceFixture(S, 7 * DAY + 100)
mailbox(U); identity(U); sequenceFixture(U, 100)
db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES ('m-u', ?, 'l-u', 'y@co.example', 'Subject here', 'A body long enough for the check.', 'uncertain')").run(U)
// N: approved, but step 1 is still a draft: nothing is due
mailbox(N); identity(N); sequenceFixture(N, 100, false)

const call = async () => (await tick(new NextRequest('http://localhost/api/internal/tick', { method: 'POST', headers: { authorization: 'Bearer test-tick-secret' } }))).json() as Promise<{ ok: boolean; tenant_failures: number; tenant_holds: number; sequences: number }>
type Row = { last_attempt_at: number; last_success_at: number | null; last_error: string | null; consecutive_failures: number; last_outcome?: string; last_hold?: string | null }
const p = (t: string, k: string) => db.prepare('SELECT * FROM scheduler_progress WHERE tenant_id = ? AND kind = ?').get(t, k) as Row | undefined
const lastRun = () => db.prepare('SELECT status, tenants_attempted, tenants_failed FROM scheduler_runs ORDER BY started_at DESC, rowid DESC LIMIT 1').get() as { status: string; tenants_attempted: number; tenants_failed: number }
const stepStatus = (seq: string, step: number) => (db.prepare('SELECT status FROM sequence_steps WHERE sequence_id = ? AND step = ?').get(seq, step) as { status: string }).status
const followupsSent = (t: string) => db.prepare("SELECT count(*) FROM followup_messages WHERE tenant_id = ? AND status = 'sent'").pluck().get(t) as number

// Uses only the columns the route recorded before the fix: on the unfixed route both rows read as success.
test('the reviewer\'s negatives: a refused sequence run and a refused follow-up run are not recorded as success', async () => {
  const r1 = await call()
  assert.equal(r1.ok, true)
  // R: runSequences returned stopped:'reading_not_enabled'
  const r = p(R, 'sequences')!
  assert.equal(r.last_success_at, null, 'no success time for refused work'); assert.equal(r.consecutive_failures, 1); assert.match(r.last_error ?? '', /reading_not_enabled/)
  // F: reply sync succeeded; runFollowups returned stopped:'not_available'
  assert.ok(p(F, 'reply_sync')!.last_success_at)
  const f = p(F, 'followups')!
  assert.equal(f.last_success_at, null); assert.equal(f.consecutive_failures, 1); assert.match(f.last_error ?? '', /not_available/)
})

test('the matrix on the real route: progress, holds, failures, blocking, recovery, counts and isolation', async () => {
  // --- after tick 1 (run above) ---
  // P: held (paused): attempted, no success, no failure, with the reason
  const p1 = p(P, 'sequences')!
  assert.equal(p1.last_success_at, null); assert.equal(p1.consecutive_failures, 0); assert.equal(p1.last_error, null); assert.equal(p1.last_outcome, 'hold'); assert.equal(p1.last_hold, 'paused')
  // S: step 2 was due and went out through the stub: actual progress
  assert.equal(stepStatus(seqS, 2), 'sent'); assert.equal(stepStatus(seqS, 3), 'approved')
  const s1 = p(S, 'sequences')!
  assert.ok(s1.last_success_at); assert.equal(s1.last_outcome, 'success'); assert.equal(s1.consecutive_failures, 0)
  // U: an uncertain send is a failure, and the worker paused the tenant
  const u1 = p(U, 'sequences')!
  assert.equal(u1.last_outcome, 'failure'); assert.equal(u1.consecutive_failures, 1); assert.match(u1.last_error ?? '', /uncertain_send/); assert.equal(u1.last_success_at, null)
  assert.equal((db.prepare('SELECT paused FROM autopilot_settings WHERE tenant_id = ?').get(U) as { paused: number }).paused, 1)
  // N: nothing due is a successful pass, not a hold
  const n1 = p(N, 'sequences')!
  assert.equal(n1.last_outcome, 'success'); assert.ok(n1.last_success_at); assert.equal(n1.last_hold, null)
  // the run: R, F and U failed; P was held; S and N succeeded
  // #413: reply sync is gated on read consent, not send flags: R has no mailbox yet, so no reply_sync row; every consenting tenant has one
  assert.equal(p(R, 'reply_sync'), undefined)
  for (const t of [F, P, S, U, N]) assert.ok(p(t, 'reply_sync'), `reply sync attempted for consenting ${t}`)
  assert.deepEqual(lastRun(), { status: 'partial', tenants_attempted: 6, tenants_failed: 3 })

  // --- tick 2: S hits the cap (one send today, cap 1): a hold that keeps its success time; U is now paused: a hold that keeps its failure
  db.prepare('UPDATE autopilot_settings SET daily_cap = 1 WHERE tenant_id = ?').run(S)
  const r2 = await call()
  assert.equal(r2.tenant_failures, 2, 'R and F'); assert.equal(r2.tenant_holds, 3, 'P, S and U'); assert.equal(r2.sequences, 0)
  const s2 = p(S, 'sequences')!
  assert.equal(s2.last_outcome, 'hold'); assert.equal(s2.last_hold, 'daily_cap'); assert.equal(s2.last_success_at, s1.last_success_at); assert.equal(s2.consecutive_failures, 0); assert.equal(s2.last_error, null)
  assert.equal(stepStatus(seqS, 3), 'approved', 'the cap wait sent nothing')
  const u2 = p(U, 'sequences')!
  assert.equal(u2.last_outcome, 'hold'); assert.equal(u2.last_hold, 'paused'); assert.equal(u2.consecutive_failures, 1, 'a hold does not reset the count'); assert.match(u2.last_error ?? '', /uncertain_send/)
  assert.deepEqual(lastRun(), { status: 'partial', tenants_attempted: 6, tenants_failed: 2 })

  // --- tick 3: R and F reach BLOCKED_AFTER_FAILURES; the operator view counts, never names
  await call()
  assert.equal(BLOCKED_AFTER_FAILURES, 3)
  assert.equal(p(R, 'sequences')!.consecutive_failures, 3); assert.equal(p(F, 'followups')!.consecutive_failures, 3)
  assert.deepEqual((await tenantFreshness(db, R)).reasons.filter(x => x.endsWith('_failing')), ['sequences_failing'])
  assert.equal((await tenantFreshness(db, F)).state, 'blocked'); assert.deepEqual((await tenantFreshness(db, F)).reasons, ['followups_failing'])
  const pf = await tenantFreshness(db, P)
  assert.equal(pf.state, 'held'); assert.deepEqual(pf.holds, ['sequences:paused']); assert.deepEqual(pf.reasons, [])
  assert.equal((await tenantFreshness(db, S)).state, 'held'); assert.equal((await tenantFreshness(db, U)).state, 'held')
  const h = await schedulerHealth(db)
  assert.equal(h.ok, false); assert.equal(h.tenants.tracked, 6); assert.equal(h.tenants.blocked, 2); assert.equal(h.tenants.held, 3)
  assert.ok(h.problems.includes('2 tenant(s) blocked by repeated failures'), JSON.stringify(h.problems))
  const body = await (await schedulerHealthResponse(db)).text()
  for (const leak of [R, F, P, S, U, N, 'reading_not_enabled', 'not_available', 'paused', 'daily_cap', 'uncertain_send', 'business', 'acme']) assert.ok(!body.includes(leak), `operator view leaks ${leak}`)
  // each tenant's own view: its rows only
  setUser({ id: P, business_name: '' })
  const seqP = await (await sequencesRoute(new NextRequest('http://localhost/api/outreach/sequences'))).text()
  const fp = JSON.parse(seqP).freshness
  assert.equal(fp.state, 'held'); assert.deepEqual(fp.holds, ['sequences:paused'])
  for (const other of [R, F, S, U, 'reading_not_enabled', 'not_available']) assert.ok(!seqP.includes(other), `tenant view leaks ${other}`) // (uncertain_send is also the name of a gate every tenant sees)
  setUser({ id: F, business_name: '' })
  assert.equal(JSON.parse(await (await sequencesRoute(new NextRequest('http://localhost/api/outreach/sequences'))).text()).freshness.state, 'blocked')

  // --- tick 4: operator switch on; F's consent is no longer current (a hold while still blocked); R gets a mailbox; P resumes; S's cap is raised;
  // W arrives with follow-ups on, two interested threads due and a cap of 1
  process.env.AUTOPILOT_ENABLED = '1'
  mailbox(W); identity(W); enable(db, W, { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 1 }); setFollowups(db, W, true)
  interestedThread(W, 'one@north.example', 4 * DAY); interestedThread(W, 'two@north.example', 4 * DAY)
  db.prepare("UPDATE autopilot_settings SET consent_version = '2000-01-01' WHERE tenant_id = ?").run(F)
  mailbox(R); identity(R)
  db.prepare('UPDATE autopilot_settings SET paused = 0, pause_reason = NULL WHERE tenant_id = ?').run(P)
  db.prepare('UPDATE autopilot_settings SET daily_cap = 10 WHERE tenant_id = ?').run(S)
  const r4 = await call()
  assert.equal(r4.sequences, 1, 'S step 3'); assert.equal(stepStatus(seqS, 3), 'sent')
  const f4 = p(F, 'followups')!
  assert.equal(f4.last_outcome, 'hold'); assert.equal(f4.last_hold, 'autopilot_off'); assert.equal(f4.consecutive_failures, 3); assert.equal(f4.last_success_at, null); assert.match(f4.last_error ?? '', /not_available/)
  assert.equal((await tenantFreshness(db, F)).state, 'blocked', 'a hold does not resolve the failures')
  const r4r = p(R, 'sequences')!
  assert.equal(r4r.last_outcome, 'success'); assert.equal(r4r.consecutive_failures, 0); assert.ok(r4r.last_success_at); assert.equal(r4r.last_error, null)
  assert.equal((await tenantFreshness(db, R)).reasons.includes('sequences_failing'), false)
  const p4 = p(P, 'sequences')!
  assert.equal(p4.last_outcome, 'success'); assert.ok(p4.last_success_at); assert.equal(p4.last_hold, null)
  assert.equal((await tenantFreshness(db, P)).state, 'healthy')
  assert.equal(p(U, 'sequences')!.last_outcome, 'hold')
  // W: one follow-up went out through the stub, then the cap stopped the second: work was done, so the tick is a success
  assert.equal(followupsSent(W), 1)
  const w4 = p(W, 'followups')!
  assert.equal(w4.last_outcome, 'success'); assert.ok(w4.last_success_at); assert.equal(w4.last_hold, null); assert.equal(w4.consecutive_failures, 0)
  assert.equal(p(W, 'reply_sync')!.last_outcome, 'success')

  // --- tick 5: F's consent is current again but its sender identity is gone: a different failure continues the count
  db.prepare('UPDATE autopilot_settings SET consent_version = ? WHERE tenant_id = ?').run(CONSENT_VERSION, F)
  db.prepare('DELETE FROM outreach_settings WHERE tenant_id = ?').run(F)
  await call()
  const f5 = p(F, 'followups')!
  assert.equal(f5.last_outcome, 'failure'); assert.equal(f5.consecutive_failures, 4); assert.match(f5.last_error ?? '', /gmail_or_identity/); assert.equal(f5.last_hold, null)
  // W: the second thread is due but today's cap is spent: a cap wait that sent nothing, keeping yesterday's success
  assert.equal(followupsSent(W), 1)
  const w5 = p(W, 'followups')!
  assert.equal(w5.last_outcome, 'hold'); assert.equal(w5.last_hold, 'daily_cap'); assert.equal(w5.last_success_at, w4.last_success_at); assert.equal(w5.consecutive_failures, 0)
  assert.equal((await tenantFreshness(db, W)).state, 'held'); assert.deepEqual((await tenantFreshness(db, W)).holds, ['followups:daily_cap'])

  // --- tick 6: identity restored: a genuine success clears F; W's cap raised: the second follow-up goes out
  identity(F)
  db.prepare('UPDATE autopilot_settings SET daily_cap = 10 WHERE tenant_id = ?').run(W)
  const r6 = await call()
  assert.equal(followupsSent(W), 2); assert.equal(p(W, 'followups')!.last_outcome, 'success'); assert.equal((await tenantFreshness(db, W)).state, 'healthy')
  assert.equal(r6.tenant_failures, 0)
  const f6 = p(F, 'followups')!
  assert.equal(f6.last_outcome, 'success'); assert.equal(f6.consecutive_failures, 0); assert.ok(f6.last_success_at); assert.equal(f6.last_error, null); assert.equal(f6.last_hold, null)
  assert.equal((await tenantFreshness(db, F)).state, 'healthy')
  // S's sequence is done and R's was stopped by a lead gate once its run could proceed: no scheduled work left for either
  assert.equal(db.prepare("SELECT count(*) AS n FROM sequences WHERE tenant_id IN (?, ?) AND status IN ('approved','active')").pluck().get(R, S), 0)
  // #413: reply sync runs for every tenant with read consent, independent of send-side state (R and S have no scheduled work left but still read)
  for (const t of [R, S]) assert.equal(p(t, 'reply_sync')!.last_outcome, 'success', `reply sync attempted for ${t} despite no send-side work`)
  assert.deepEqual(lastRun(), { status: 'ok', tenants_attempted: 7, tenants_failed: 0 }, 'F, P, R, S, U, N, W')
  const h6 = await schedulerHealth(db)
  assert.equal(h6.tenants.blocked, 0); assert.equal(h6.tenants.held, 1, 'U is still paused with its uncertain send')
  assert.equal(h6.problems.some(x => /blocked/.test(x)), false)
})

// Two schedulers fire at once: one tick runs, the other is skipped by the lease, and every tenant's progress carries
// exactly one attempt for the one run (positive control for the single effect per tenant and kind).
test('two ticks at once: one runs, one is skipped, one run row, one attempt per tenant and kind', async () => {
  const before = db.prepare('SELECT count(*) FROM scheduler_runs').pluck().get() as number
  const [a, b] = await Promise.all([call(), call()]) as unknown as { run?: string; skipped?: string }[]
  const ran = [a, b].filter(r => r.run), skipped = [a, b].filter(r => r.skipped)
  assert.equal(ran.length, 1); assert.equal(skipped.length, 1); assert.equal(skipped[0].skipped, 'another tick is running')
  assert.equal(db.prepare('SELECT count(*) FROM scheduler_runs').pluck().get(), before + 1)
  // every tenant with work has exactly one row per kind, all stamped with the one run (the primary key allows no second);
  // #413: every consenting tenant also has its reply_sync row, independent of send-side work
  const rows = db.prepare('SELECT tenant_id, kind FROM scheduler_progress WHERE last_run_id = ? ORDER BY tenant_id, kind').all(ran[0].run) as { tenant_id: string; kind: string }[]
  assert.deepEqual(rows.map(r => `${r.tenant_id}/${r.kind}`), [`${F}/first_touch`, `${F}/followups`, `${F}/reply_sync`, `${N}/reply_sync`, `${N}/sequences`, `${P}/reply_sync`, `${P}/sequences`, `${R}/reply_sync`, `${S}/reply_sync`, `${U}/reply_sync`, `${U}/sequences`, `${W}/first_touch`, `${W}/followups`, `${W}/reply_sync`])
  assert.deepEqual(lastRun(), { status: 'ok', tenants_attempted: 7, tenants_failed: 0 })
})

// A worker that throws (its table is gone for one tick) is a failure with the error's class, never a stop of the whole
// tick; the run is partial; a hold afterwards keeps that failure; the table back, the next run clears it.
test('a thrown worker error is recorded as that tenant\'s failure; the tick goes on; recovery clears it', async () => {
  db.exec('ALTER TABLE sequence_steps RENAME TO sequence_steps_gone')
  try { const r = await call(); assert.equal(r.ok, true); assert.ok(r.tenant_failures >= 3, 'P, U and N') } finally { db.exec('ALTER TABLE sequence_steps_gone RENAME TO sequence_steps') }
  for (const t of [P, U, N]) { const x = p(t, 'sequences')!; assert.equal(x.last_outcome, 'failure', t); assert.match(x.last_error ?? '', /^SqliteError: no such table/, t) }
  assert.equal(p(U, 'sequences')!.consecutive_failures, 2, 'the uncertain send plus this one')
  assert.equal(p(P, 'sequences')!.consecutive_failures, 1); assert.ok(p(P, 'sequences')!.last_success_at, 'the last success stays')
  assert.equal(lastRun().status, 'partial')
  assert.equal(p(W, 'followups')!.last_outcome, 'success', 'the follow-up loop was not affected')
  await call()
  for (const t of [P, N]) { const x = p(t, 'sequences')!; assert.equal(x.last_outcome, 'success', t); assert.equal(x.consecutive_failures, 0); assert.equal(x.last_error, null) }
  const u = p(U, 'sequences')!
  assert.equal(u.last_outcome, 'hold'); assert.equal(u.consecutive_failures, 2); assert.match(u.last_error ?? '', /no such table/, 'a hold keeps the last failure')
  assert.equal(lastRun().status, 'ok')
})

// The kill switch: every tenant with work on is refused (follow-ups not_available, sequences sequences_disabled); a
// paused tenant is still a hold (its pause comes first); clearing the switch recovers everyone on the next run.
test('kill switch on: refusals for every tenant with work, a hold stays a hold; off: recovery', async () => {
  process.env.AUTOPILOT_KILL = '1'
  const r = await call()
  assert.equal(r.tenant_failures, 4, 'F and W follow-ups, P and N sequences'); assert.equal(r.tenant_holds, 1, 'U')
  for (const t of [F, W]) { const x = p(t, 'followups')!; assert.equal(x.last_outcome, 'failure', t); assert.match(x.last_error ?? '', /not_available/); assert.equal(p(t, 'reply_sync')!.last_outcome, 'success', 'reading replies is not switched off by the kill switch') }
  for (const t of [P, N]) { const x = p(t, 'sequences')!; assert.equal(x.last_outcome, 'failure', t); assert.match(x.last_error ?? '', /sequences_disabled/) }
  assert.equal(p(U, 'sequences')!.last_hold, 'paused')
  assert.equal(lastRun().status, 'partial')
  delete process.env.AUTOPILOT_KILL
  const r2 = await call()
  assert.equal(r2.tenant_failures, 0)
  for (const [t, k] of [[F, 'followups'], [W, 'followups'], [P, 'sequences'], [N, 'sequences']]) { const x = p(t, k)!; assert.equal(x.last_outcome, 'success', `${t}/${k}`); assert.equal(x.consecutive_failures, 0) }
  assert.equal((await schedulerHealth(db)).tenants.blocked, 0)
})
