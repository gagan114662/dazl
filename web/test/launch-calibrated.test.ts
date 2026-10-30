import { seedOffers } from './helpers/seed-offer.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateReplies } from '../lib/outreach/replies.ts'
import { completeOAuth, startOAuth, GMAIL_READ_SCOPE } from '../lib/gmail/oauth.ts'
import { saveSettings, type Deps } from '../lib/outreach/service.ts'
import { ATTESTATIONS, auditAt, CONSENT_VERSION, enable, getState, migrateAutopilot, recentAutopilotAudit, runAutopilot } from '../lib/outreach/autopilot.ts'
import { acceptLaunchPolicy, launchGate, readLaunchPolicy, reserveLaunchSpend, LAUNCH_POLICY_VERSION, POLISH_RESERVE_USD, ROLLOUT_DAILY_CAP, ROLLOUT_DAYS } from '../lib/outreach/launch-policy.ts'
import { runCalibration } from '../lib/outreach/calibration.ts'

// #405 wiring: a calibrated launch replaces the hand-approval warmup only after an accepted policy passes the machine
// preflight. Synthetic tenant and leads (.example); every Gmail call is a stub that records what would have been sent.
const master = randomBytes(32)
const genv = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const ON = { AUTOPILOT_ENABLED: '1' } // default warmup of 10
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'

async function connect(db: Database.Database, email: string, read = true) {
  const state = new URL(startOAuth(db, 'A', { env: genv, now: NOW })).searchParams.get('state')!
  const scope = ['https://www.googleapis.com/auth/gmail.send', ...(read ? [GMAIL_READ_SCOPE] : [])].join(' ')
  await completeOAuth(db, 'A', 'c', state, { env: genv, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope, id_token: idToken(email) })) as unknown as typeof fetch })
}
async function setup() {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateReplies(db); seedOffers(db)
  await connect(db, 'me@acme.example')
  saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 20 })
  return db
}
const play = (db: Database.Database) => {
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  return job
}
function lead(db: Database.Database, job: string, contact: string) {
  const id = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, job, 'Co ' + id.slice(0, 4), contact, 'Hiring roofers', 'https://n.example/a', 'Co is hiring', 90, 80)
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE id = ?").run(id)
  return id
}
const policy = (playIds: string[], over: Record<string, unknown> = {}) => ({
  version: LAUNCH_POLICY_VERSION, sender: 'me@acme.example', audience: { playIds }, exclusions: { domains: ['customer.example'], emails: [] },
  dailyCap: 20, spendCapUsd: 25, claims: { mayStatePrice: true, benchmarkUrls: [] }, stops: { pauseOnAnyReply: true, maxBounceRate: 0.05 },
  testInbox: 'me@acme.example', ...over,
})
// A recorded Gmail: sends are captured; the mailbox can be searched by Message-ID. delivered=false: Gmail accepts the
// send but the message never shows up in the INBOX (no receipt).
const gmail = (fail = false, delivered = true) => {
  const sent: string[] = []
  const ids = () => sent.map(r => /^Message-ID: <(.*)>$/m.exec(Buffer.from(r, 'base64url').toString())?.[1])
  const fetchImpl = (async (url: string) => {
    const u = String(url)
    if (u.includes('oauth2') || u.includes('token')) return json({ access_token: 'at' })
    const q = /[?&]q=([^&]*)/.exec(u)
    if (q) { const want = decodeURIComponent(q[1]).replace(/^rfc822msgid:/, ''); return json({ messages: delivered && ids().includes(want) ? [{ id: 'inbox1' }] : [] }) }
    if (u.endsWith('/inbox1?format=minimal')) return json({ id: 'inbox1', labelIds: ['INBOX', 'SENT'] })
    return json({}, 404)
  }) as unknown as typeof fetch
  const d: Deps & { flags: Record<string, string> } = { flags: ON, env: genv, master, now: NOW, baseUrl: 'https://app.test', fetchImpl,
    sendFn: (async (_t: string, raw: string) => { if (fail) throw new Error('gmail down'); sent.push(raw); return { id: 'g' + sent.length } }) as never }
  const to = () => sent.map(r => /^To: (.*)$/m.exec(Buffer.from(r, 'base64url').toString())?.[1])
  return { sent, d, to }
}
const statuses = (db: Database.Database) => db.prepare('SELECT status FROM outreach_messages ORDER BY created_at, rowid').all().map(r => (r as { status: string }).status)

test('without a calibrated launch the hand-approval warmup is unchanged; accepting a policy alone changes nothing', async () => {
  const db = await setup(); const job = play(db); lead(db, job, 'a@one.example'); lead(db, job, 'b@two.example')
  const g = gmail()
  assert.deepEqual(acceptLaunchPolicy(db, 'A', policy([job]), NOW), { ok: true })
  assert.equal(launchGate(db, 'A', 'me@acme.example', NOW).calibrated, false, 'accepted but no passing preflight')
  const r = await runAutopilot(db, 'A', 'Acme', g.d)
  assert.deepEqual([r.sent, r.held], [0, 2]); assert.equal(g.sent.length, 0)
  assert.ok(recentAutopilotAudit(db, 'A').every(a => a.action !== 'sent'))
})

test('calibration: samples stay drafts, the only message goes to the owned test inbox, and a passing run launches', async () => {
  const db = await setup(); const job = play(db); for (const c of ['a@one.example', 'b@two.example', 'c@three.example']) lead(db, job, c)
  acceptLaunchPolicy(db, 'A', policy([job]), NOW)
  const cal = gmail()
  const r = await runCalibration(db, 'A', 'Acme', cal.d)
  assert.deepEqual(r, { ok: true, failures: [], heldLeads: [] })
  assert.deepEqual(cal.to(), ['me@acme.example'], 'calibration emails only the authenticated sender itself')
  assert.deepEqual(statuses(db), ['draft', 'draft', 'draft'], 'sample drafts are not sent')
  assert.equal(readLaunchPolicy(db, 'A')!.launchedAt, NOW)
  // launched: autopilot now sends new first touches without ten hand approvals, through every existing guard. The sample
  // drafts stay the tenant's own drafts (autopilot never re-drafts a lead that already has a message).
  lead(db, job, 'd@four.example'); lead(db, job, 'e@five.example')
  const g = gmail()
  const run = await runAutopilot(db, 'A', 'Acme', g.d)
  assert.equal(run.sent, 2); assert.deepEqual(g.to(), ['d@four.example', 'e@five.example'])
  assert.ok(!recentAutopilotAudit(db, 'A').some(a => a.action === 'held_warmup'))
})

test('failed checks hold the launch: test inbox not reached, too few samples, a different mailbox, a policy without authority', async () => {
  const db = await setup(); const job = play(db); for (const c of ['a@one.example', 'b@two.example', 'c@three.example']) lead(db, job, c)
  acceptLaunchPolicy(db, 'A', policy([job]), NOW)
  assert.ok((await runCalibration(db, 'A', 'Acme', gmail(true).d)).failures.includes('test_inbox_failed'))
  assert.equal(readLaunchPolicy(db, 'A')!.launchedAt, null)
  // an audience with too few usable leads
  acceptLaunchPolicy(db, 'A', policy([play(db)]), NOW)
  assert.ok((await runCalibration(db, 'A', 'Acme', gmail().d)).failures.includes('too_few_samples'))
  // price claims without price authority hold the samples (the drafts state the offer's price)
  acceptLaunchPolicy(db, 'A', policy([job], { claims: { mayStatePrice: false, benchmarkUrls: [] } }), NOW)
  const priced = await runCalibration(db, 'A', 'Acme', gmail().d)
  if (!priced.ok) assert.ok(priced.failures.includes('sample_claims'))
  // invalid policies are refused at acceptance
  for (const inbox of ['qa@acme.example', 'someone@else.example']) assert.deepEqual(acceptLaunchPolicy(db, 'A', policy([job], { testInbox: inbox }), NOW), { ok: false, problems: ['test_inbox_not_owned'] }, inbox)
  const bad = acceptLaunchPolicy(db, 'A', policy([job], { testInbox: 'someone@else.example', dailyCap: 500 }), NOW)
  assert.deepEqual(bad, { ok: false, problems: ['daily_cap_invalid', 'test_inbox_not_owned'] })
  // a different connected mailbox: the policy's authority does not carry over
  acceptLaunchPolicy(db, 'A', policy([job]), NOW)
  assert.equal((await runCalibration(db, 'A', 'Acme', gmail().d)).ok, true)
  assert.equal(launchGate(db, 'A', 'other@acme.example', NOW).calibrated, false)
  await connect(db, 'other@acme.example')
  lead(db, job, 'd@four.example')
  const g = gmail()
  const run = await runAutopilot(db, 'A', 'Acme', g.d)
  assert.equal(g.sent.length, 0); assert.ok(run.held >= 1)
})

test('a new acceptance or a stale version clears the launch: changed authority needs a new passing preflight', async () => {
  const db = await setup(); const job = play(db); for (const c of ['a@one.example', 'b@two.example', 'c@three.example']) lead(db, job, c)
  acceptLaunchPolicy(db, 'A', policy([job]), NOW)
  await runCalibration(db, 'A', 'Acme', gmail().d)
  assert.equal(launchGate(db, 'A', 'me@acme.example', NOW).calibrated, true)
  acceptLaunchPolicy(db, 'A', policy([job], { dailyCap: 30 }), NOW + 10)
  assert.equal(launchGate(db, 'A', 'me@acme.example', NOW + 10).calibrated, false)
  await runCalibration(db, 'A', 'Acme', gmail().d)
  db.prepare("UPDATE autopilot_launch_policy SET version = '2026-01-01'").run()
  assert.equal(launchGate(db, 'A', 'me@acme.example', NOW).calibrated, false)
})

test('a calibrated launch only sends inside the policy, under the first-week rollout cap', async () => {
  const db = await setup(); const job = play(db); const other = play(db)
  for (let i = 0; i < 12; i++) lead(db, job, `p${i}@co${i}.example`)
  const outside = lead(db, other, 'x@outside.example'); const excluded = lead(db, job, 'boss@customer.example')
  db.prepare('UPDATE leads SET score = 99 WHERE id IN (?, ?)').run(outside, excluded) // reached first, before any cap
  acceptLaunchPolicy(db, 'A', policy([job]), NOW)
  await runCalibration(db, 'A', 'Acme', gmail().d)
  const g = gmail()
  const r = await runAutopilot(db, 'A', 'Acme', g.d)
  assert.equal(g.sent.length, ROLLOUT_DAILY_CAP, 'strict cap in the first week, whatever the policy and tenant caps say')
  assert.equal(r.stopped, 'daily_cap')
  assert.ok(!g.to().includes('x@outside.example') && !g.to().includes('boss@customer.example'))
  const msgs = db.prepare('SELECT lead_id FROM outreach_messages WHERE lead_id IN (?, ?)').all(outside, excluded)
  assert.equal(msgs.length, 0, 'no draft is even written outside the policy')
  const skipped = recentAutopilotAudit(db, 'A').filter(a => a.action === 'skipped').map(a => a.detail).sort()
  assert.deepEqual(skipped, ['excluded', 'not_in_audience'])
  // after the first week the policy's own cap applies (still under the tenant's daily cap)
  const gate = launchGate(db, 'A', 'me@acme.example', NOW + ROLLOUT_DAYS * 86400)
  assert.ok(gate.calibrated && gate.cap === 20)
})

test('the policy\'s stops pause the launch: any reply, a bounce rate over the limit, or a store that cannot be read', async () => {
  const db = await setup(); const job = play(db); for (let i = 0; i < 4; i++) lead(db, job, `p${i}@co${i}.example`)
  acceptLaunchPolicy(db, 'A', policy([job]), NOW)
  await runCalibration(db, 'A', 'Acme', gmail().d)
  db.prepare("INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at) VALUES ('r1', 'A', 't1', NULL, 'p0@co0.example', 'thanks', 'positive', ?)").run(NOW + 1)
  const g = gmail()
  assert.equal((await runAutopilot(db, 'A', 'Acme', { ...g.d, now: NOW + 2 })).stopped, 'reply_received')
  assert.equal(g.sent.length, 0); assert.equal(getState(db, 'A').pause_reason, 'reply_received')

  const db2 = await setup(); const job2 = play(db2); for (let i = 0; i < 4; i++) lead(db2, job2, `p${i}@co${i}.example`)
  acceptLaunchPolicy(db2, 'A', policy([job2]), NOW)
  await runCalibration(db2, 'A', 'Acme', gmail().d)
  auditAt(db2, 'A', 'bounce', 'gone@co9.example', undefined, undefined, NOW + 1) // as recordBounce writes it, at fixture time
  assert.equal((await runAutopilot(db2, 'A', 'Acme', { ...gmail().d, now: NOW + 2 })).stopped, 'bounce_rate')

  const db3 = await setup(); const job3 = play(db3); for (let i = 0; i < 4; i++) lead(db3, job3, `p${i}@co${i}.example`)
  acceptLaunchPolicy(db3, 'A', policy([job3]), NOW)
  await runCalibration(db3, 'A', 'Acme', gmail().d)
  db3.exec('DROP TABLE inbound_messages')
  const g3 = gmail()
  assert.equal((await runAutopilot(db3, 'A', 'Acme', { ...g3.d, now: NOW + 2 })).stopped, 'stop_check_unavailable')
  assert.equal(g3.sent.length, 0)
})

test('HOLD: provider acceptance is not receipt: the integration message must be found in the INBOX, with read access', async () => {
  const db = await setup(); const job = play(db); for (const c of ['a@one.example', 'b@two.example', 'c@three.example']) lead(db, job, c)
  acceptLaunchPolicy(db, 'A', policy([job]), NOW)
  // Gmail returns an id, but the message never reaches the inbox
  const lost = gmail(false, false)
  const r = await runCalibration(db, 'A', 'Acme', lost.d)
  assert.equal(lost.sent.length, 1); assert.ok(r.failures.includes('test_inbox_failed')); assert.equal(readLaunchPolicy(db, 'A')!.launchedAt, null)
  // send-only grant: receipt cannot be read, so it is not assumed
  await connect(db, 'me@acme.example', false)
  assert.ok((await runCalibration(db, 'A', 'Acme', gmail().d)).failures.includes('test_inbox_failed'))
  assert.equal(launchGate(db, 'A', 'me@acme.example', NOW).calibrated, false)
})

test('HOLD: the current policy\'s claim authority applies to every final outgoing draft, including changes since calibration', async () => {
  const db = await setup(); const job = play(db); for (const c of ['a@one.example', 'b@two.example', 'c@three.example']) lead(db, job, c)
  acceptLaunchPolicy(db, 'A', policy([job]), NOW)
  assert.equal((await runCalibration(db, 'A', 'Acme', gmail().d)).ok, true)
  // Instinct's repro: the stored policy now prohibits price, the offer now states one, a new eligible lead arrives
  const stored = readLaunchPolicy(db, 'A')!.policy
  db.prepare('UPDATE autopilot_launch_policy SET policy = ?').run(JSON.stringify({ ...stored, claims: { mayStatePrice: false, benchmarkUrls: [] } }))
  db.prepare('UPDATE scan_jobs SET offer = ? WHERE id = ?').run('CRM setup at $999 per month', job)
  lead(db, job, 'd@four.example')
  const g = gmail()
  const r = await runAutopilot(db, 'A', 'Acme', g.d)
  assert.equal(g.sent.length, 0, 'nothing priced goes out'); assert.equal(r.sent, 0)
  const body = (db.prepare("SELECT body FROM outreach_messages ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { body: string }).body
  assert.match(body, /\$999/, 'the draft carries the new price')
  assert.ok(recentAutopilotAudit(db, 'A').some(a => a.action === 'held_claims'))
  // with price authority the same draft content would be allowed
  db.prepare('UPDATE autopilot_launch_policy SET policy = ?').run(JSON.stringify(stored))
  lead(db, job, 'e@five.example')
  assert.equal((await runAutopilot(db, 'A', 'Acme', gmail().d)).sent, 1)
})

test('HOLD: the launch spend cap is reserved in the shared store before any model work, and fails closed', async () => {
  const db = await setup(); const job = play(db); for (let i = 0; i < 8; i++) lead(db, job, `p${i}@co${i}.example`)
  acceptLaunchPolicy(db, 'A', policy([job], { spendCapUsd: 0.25 }), NOW)
  await runCalibration(db, 'A', 'Acme', gmail().d)
  const g = gmail()
  const r = await runAutopilot(db, 'A', 'Acme', g.d)
  assert.equal(r.stopped, 'launch_spend_cap'); assert.equal(g.sent.length, 2, 'two reservations of the ceiling fit under 0.25; the third does not')
  assert.equal(getState(db, 'A').pause_reason, 'launch_spend_cap')
  const launchedAt = readLaunchPolicy(db, 'A')!.launchedAt!
  // reservations are atomic against the cap: none fits once the cap is reached, whoever asks
  assert.equal(reserveLaunchSpend(db, 'A', launchedAt, 0.25, POLISH_RESERVE_USD, NOW), 'over_cap')
  // a store that cannot record the reservation refuses the work
  const db2 = await setup(); const job2 = play(db2); for (let i = 0; i < 4; i++) lead(db2, job2, `p${i}@co${i}.example`)
  acceptLaunchPolicy(db2, 'A', policy([job2]), NOW)
  await runCalibration(db2, 'A', 'Acme', gmail().d)
  lead(db2, job2, 'new@co9.example')
  db2.exec('DROP TABLE tenant_spend_pools')
  const g2 = gmail()
  assert.equal((await runAutopilot(db2, 'A', 'Acme', g2.d)).stopped, 'spend_check_unavailable'); assert.equal(g2.sent.length, 0)
})
