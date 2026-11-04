// Two-tenant orchestration through the REAL tick route (app/api/internal/tick/route.ts), run by
// test/tick-isolation.test.ts through the tenant-route loader on in-memory SQLite (production's store).
// The job-isolation guard (test/job-isolation.test.ts) tests each worker directly with injected deps; this file
// tests what only the route owns: which tenants its selection queries pick, per-tenant failure containment in
// the loop, and the tenant attribution of scheduler_progress rows. Synthetic fixtures, net-fenced, real wall
// clock because the route injects no clock. Test 1 runs staging-mode (token/send/Gmail reads stubbed by the
// libs); test 2 runs NON-staging with Google client credentials absent, so a read-enabled tenant's token step
// fails deterministically (gmail_unavailable) without any network attempt.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { seedOffers } from './seed-offer.ts'
import { startOAuth, completeOAuth, GMAIL_READ_SCOPE } from '../../lib/gmail/oauth.ts'
import { saveSettings } from '../../lib/outreach/service.ts'
import { ATTESTATIONS, CONSENT_VERSION, enable } from '../../lib/outreach/autopilot.ts'
import { setFollowups } from '../../lib/outreach/followups.ts'
import { acceptReadConsent } from '../../lib/outreach/replies.ts'
import { createJob } from '../../lib/scan/store.ts'
import { POST } from '../../app/api/internal/tick/route.ts'

process.env.DAZL_ENV = 'staging'
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
process.env.AUTOPILOT_TICK_SECRET = 'test-tick-secret'
process.env.AUTOPILOT_ENABLED = '1'
process.env.AUTOPILOT_WARMUP = '2'
process.env.SEQUENCES_ENABLED = '1'
delete process.env.AUTOPILOT_KILL; delete process.env.ACCOUNT_RETENTION_ENABLED; delete process.env.AUDIT_RETENTION_DAYS
delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET // test 2's token failure must be deterministic

const master = randomBytes(32)
const genv = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://app.test' }
const nowS = () => Math.floor(Date.now() / 1000)
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
const hex = () => randomBytes(12).toString('hex')

function world() {
  const raw = new Database(':memory:')
  migrateAllSqlite(raw)
  setScanDb(raw)
  // A fully configured tenant: connected Gmail, sender identity, current send consent, follow-ups on; read
  // consent and the read scope only when read=true (OAuth helpers never create the users row the route joins on).
  async function onboard(t: string, email: string, read = true) {
    raw.prepare("INSERT INTO users (id, email, business_name, password_hash, salt, created_at) VALUES (?, ?, ?, 'x', 'x', ?)").run(t, email, `${t} Co`, nowS())
    const state = new URL(startOAuth(raw, t, { env: genv, now: nowS(), withRead: read })).searchParams.get('state')!
    await completeOAuth(raw, t, 'c', state, { env: genv, master, now: nowS(), fetchImpl: (async () => json({ refresh_token: 'rt', scope: `https://www.googleapis.com/auth/gmail.send${read ? ' ' + GMAIL_READ_SCOPE : ''}`, id_token: idToken(email) })) as unknown as typeof fetch })
    saveSettings(raw, t, { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
    enable(raw, t, { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 5 })
    setFollowups(raw, t, true)
    if (read) acceptReadConsent(raw, t)
  }
  function warmed(t: string) { for (let i = 0; i < 2; i++) raw.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES (?, ?, ?, ?, 's', 'bodybodybodybodybodybody', 'sent', ?, ?)").run(hex(), t, 'x' + i, `o${i}@z.example`, nowS() - 9e5, nowS() - 9e5) }
  function addLead(t: string, contact: string) {
    const job = createJob(raw, t, { business_name: 'Northside', industry: 'x', location: 'y' })
    raw.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
    const id = hex()
    raw.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, job, 'Northside', contact, 'Hiring roofers', 'https://n.example/a', 'Northside is hiring', 90, 80)
    raw.prepare("UPDATE leads SET human_confirmed_at = ?, human_confirmed_from = 'test_review' WHERE id = ?").run(nowS(), id)
    raw.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)
    return id
  }
  const progressRows = (t: string) => raw.prepare('SELECT kind, last_outcome, last_attempt_at FROM scheduler_progress WHERE tenant_id = ? ORDER BY kind').all(t) as { kind: string; last_outcome: string; last_attempt_at: number }[]
  const count = (sql: string, ...args: unknown[]) => (raw.prepare(sql).get(...args) as { n: number }).n
  const sendOrder = () => (raw.prepare('SELECT s.tenant_id FROM autopilot_settings s JOIN users u ON u.id = s.tenant_id WHERE s.enabled = 1 AND s.paused = 0 AND s.followups_enabled = 1').all() as { tenant_id: string }[]).map(r => r.tenant_id)
  async function tick() {
    const res = await POST(new NextRequest('http://localhost/api/internal/tick', { method: 'POST', headers: { authorization: 'Bearer test-tick-secret' } }))
    assert.equal(res.status, 200)
    return await res.json() as { ok: boolean; run: string; tenants: number; tenant_failures: number; first_touches: number }
  }
  const runStatus = (id: string) => (raw.prepare('SELECT status FROM scheduler_runs WHERE id = ?').get(id) as { status: string }).status
  return { raw, onboard, warmed, addLead, progressRows, count, sendOrder, tick, runStatus }
}

test('[sqlite] tick route, two live tenants plus a paused one: selection, attribution, then first-touch containment', async () => {
  const w = world()
  await w.onboard('A', 'me@a.example'); await w.onboard('B', 'me@b.example'); await w.onboard('C', 'me@c.example')
  w.raw.prepare("UPDATE autopilot_settings SET paused = 1 WHERE tenant_id = 'C'").run()
  seedOffers(w.raw, ['A', 'B', 'C'])
  w.warmed('A'); w.warmed('B'); w.warmed('C')
  w.addLead('B', 'sam@b.example')
  w.addLead('C', 'pat@c.example')
  // Precondition the containment half relies on: the route's own send selection must visit A before B, or a
  // break-on-failure regression would have no observable effect. Asserted, not assumed.
  assert.deepEqual(w.sendOrder().filter(t => t === 'A' || t === 'B'), ['A', 'B'], 'precondition: the route visits A before B')

  // Phase 1: one tick over a healthy store. Both live tenants get every kind; the paused tenant is read-only.
  const body1 = await w.tick()
  assert.equal(body1.ok, true)
  assert.equal(body1.tenants, 3, 'A and B worked, C read-only but counted')
  assert.equal(body1.tenant_failures, 0)
  assert.equal(body1.first_touches, 1, "exactly B's verified lead is sent")
  assert.equal(w.count("SELECT count(*) AS n FROM outreach_messages WHERE tenant_id = 'B' AND to_email = 'sam@b.example' AND status = 'sent'"), 1, "B's first touch sent under B")
  assert.equal(w.count("SELECT count(*) AS n FROM outreach_messages WHERE tenant_id != 'B' AND to_email = 'sam@b.example'"), 0, "B's send never attributed to another tenant")
  assert.equal(w.count("SELECT count(*) AS n FROM outreach_messages WHERE to_email = 'pat@c.example'"), 0, 'paused C: nothing drafted or sent')
  assert.equal(w.count("SELECT count(*) AS n FROM outreach_messages WHERE tenant_id = 'A' AND to_email NOT LIKE '%@z.example'"), 0, 'idle A: no work invented')
  const kinds = (t: string) => w.progressRows(t).map(r => r.kind)
  assert.deepEqual(kinds('A'), ['first_touch', 'followups', 'reply_sync'], 'A visited for every kind its config selects')
  assert.deepEqual(kinds('B'), ['first_touch', 'followups', 'reply_sync'], 'B visited for every kind its config selects')
  assert.deepEqual(kinds('C'), ['reply_sync'], 'paused C gets safety ingest only, never send-side kinds')
  for (const t of ['A', 'B', 'C']) for (const r of w.progressRows(t)) assert.notEqual(r.last_outcome, 'failure', `${t}/${r.kind} must not fail on a healthy store`)
  assert.equal(w.runStatus(body1.run), 'ok')

  // Phase 2: A's mailbox is disconnected between ticks. Follow-ups refuse as a failure (gmail_or_identity);
  // the loop must record it, skip A's remaining kinds, and still run B fully.
  const aFirstTouchBefore = w.progressRows('A').find(r => r.kind === 'first_touch')!.last_attempt_at
  const bFirstTouchBefore = w.progressRows('B').find(r => r.kind === 'first_touch')!.last_attempt_at
  w.raw.prepare("DELETE FROM gmail_accounts WHERE tenant_id = 'A'").run()
  w.addLead('A', 'new@a.example')
  w.addLead('B', 'new@b.example')
  await new Promise(r => setTimeout(r, 1100)) // attempt timestamps are second-granularity: make tick 2 strictly later
  const body2 = await w.tick()
  assert.equal(body2.ok, true)
  assert.equal(body2.tenants, 2, 'B worked and C read-only; failing A is not counted done')
  assert.equal(body2.tenant_failures, 1, 'exactly A fails')
  const aProg = w.progressRows('A')
  assert.equal(aProg.find(r => r.kind === 'followups')!.last_outcome, 'failure', "A's follow-ups refusal recorded as failure")
  assert.equal(aProg.find(r => r.kind === 'reply_sync')!.last_outcome, 'hold', "A's missing mailbox is a hold for reply sync, not a failure")
  assert.equal(aProg.find(r => r.kind === 'first_touch')!.last_attempt_at, aFirstTouchBefore, "A's first touch skipped after the failure: attempt time unchanged")
  assert.equal(w.count("SELECT count(*) AS n FROM outreach_messages WHERE to_email = 'new@a.example'"), 0, "A's due lead untouched while A is failing")
  assert.equal(w.count("SELECT count(*) AS n FROM outreach_messages WHERE tenant_id = 'B' AND to_email = 'new@b.example'"), 1, "B's first touch ran: its new lead was worked (drafted or sent)")
  assert.equal(w.count("SELECT count(*) AS n FROM outreach_messages WHERE tenant_id != 'B' AND to_email = 'new@b.example'"), 0, "B's new work never attributed to another tenant")
  assert.ok(w.progressRows('B').find(r => r.kind === 'first_touch')!.last_attempt_at > bFirstTouchBefore, "B's first touch re-attempted on the second tick")
  assert.equal(w.count("SELECT count(*) AS n FROM outreach_messages WHERE to_email = 'pat@c.example'"), 0, 'paused C still untouched')
  assert.deepEqual(w.progressRows('C').map(r => r.kind), ['reply_sync'], 'C stays read-only through the degraded tick')
  assert.equal(w.runStatus(body2.run), 'partial', 'run records the partial outcome')
})

test('[sqlite] tick route: a real reply-sync failure contains to its tenant; the next tenant still runs', async () => {
  // Non-staging (DAZL_ENV != 'staging') with Google client credentials absent: a read-enabled tenant's token
  // step fails deterministically with gmail_unavailable, a genuine reply-sync FAILURE (not a hold), before any
  // network attempt. The healthy tenant has no read consent, so its sync is the usual hold and its pass runs.
  process.env.DAZL_ENV = 'test'
  const w = world()
  await w.onboard('D', 'me@d.example', true)   // read enabled: reply sync will fail at the token step
  await w.onboard('E', 'me@e.example', false)  // send-only: reply sync holds, the rest of the pass runs
  seedOffers(w.raw, ['D', 'E'])
  w.warmed('D'); w.warmed('E')
  w.addLead('D', 'lead@d.example')
  assert.deepEqual(w.sendOrder().filter(t => t === 'D' || t === 'E'), ['D', 'E'], 'precondition: the route visits D before E')
  const body = await w.tick()
  assert.equal(body.ok, true)
  assert.equal(body.tenants, 1, 'only E completes; failing D is not counted done')
  assert.equal(body.tenant_failures, 1, 'exactly D fails')
  const dProg = w.progressRows('D')
  assert.deepEqual(dProg.map(r => r.kind), ['reply_sync'], "D's failure stops its own pass at reply sync")
  assert.equal(dProg[0].last_outcome, 'failure', "D's reply sync recorded as a genuine failure")
  assert.equal(w.count("SELECT count(*) AS n FROM outreach_messages WHERE to_email = 'lead@d.example'"), 0, "D's due lead untouched while D is failing")
  const eProg = w.progressRows('E')
  assert.deepEqual(eProg.map(r => r.kind), ['first_touch', 'followups', 'reply_sync'], 'E still visited for every kind its config selects')
  assert.equal(eProg.find(r => r.kind === 'reply_sync')!.last_outcome, 'hold', "E's missing read consent is a hold, not a failure")
  assert.equal(eProg.find(r => r.kind === 'first_touch')!.last_outcome, 'success', "E's first touch ran")
  assert.equal(w.runStatus(body.run), 'partial', 'run records the partial outcome')
})
