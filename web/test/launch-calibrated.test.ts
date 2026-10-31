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
import { approve, createDraft, OutreachError, saveSettings, sendMessage, type Deps } from '../lib/outreach/service.ts'
import { ATTESTATIONS, auditAt, CONSENT_VERSION, disable, enable, getState, migrateAutopilot, pause, recentAutopilotAudit, runAutopilot } from '../lib/outreach/autopilot.ts'
import { acceptLaunchPolicy, launchGate, parsePolicy, readLaunchPolicy, reserveLaunchSpend, LAUNCH_POLICY_VERSION, ROLLOUT_DAILY_CAP, ROLLOUT_DAYS } from '../lib/outreach/launch-policy.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { callCostUsd } from '../lib/llm/spend-guard.ts'
import type { Provider, DetailedCompletion } from '../lib/llm/provider.ts'
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

// A recorded model: every completion is captured with the max_tokens it was allowed; usage is what the test says the
// provider reported (undefined: none). The rewrite is not usable, so the template stays: only spend is under test.
const model = (id: string, usage: (prompt: string) => DetailedCompletion['usage']) => {
  const calls: { prompt: string; max: number }[] = []
  const p: Provider = {
    research: async () => { throw new Error('no research') },
    configuredModel: () => id,
    completeDetailed: async (_k, prompt, _f, max = 10) => { calls.push({ prompt, max }); return { text: 'not a draft', model: id, usage: usage(prompt) } },
  }
  return { calls, providers: { anthropic: p, openai: p } }
}
const pool = (db: Database.Database) => db.prepare("SELECT reserved_usd, reported_usd, calls FROM tenant_spend_pools WHERE period LIKE 'l:%'").get() as { reserved_usd: number; reported_usd: number; calls: number } | undefined
async function launchedWithKey(cap: number) {
  const db = await setup(); migrateKeys(db); saveKey(db, 'A', 'anthropic', 'sk-ant-synthetic-0000', master)
  const job = play(db); for (const c of ['a@one.example', 'b@two.example', 'c@three.example']) lead(db, job, c)
  acceptLaunchPolicy(db, 'A', policy([job], { spendCapUsd: cap }), NOW)
  assert.equal((await runCalibration(db, 'A', 'Acme', gmail().d)).ok, true)
  return { db, job }
}

test('HOLD: every model call reserves its real worst case before it runs, then settles to what the provider reported', async () => {
  // reported cost below the ceiling: the reservation moves down to it
  const { db, job } = await launchedWithKey(5)
  lead(db, job, 'd@four.example')
  const m = model('claude-sonnet-4-5', () => ({ input_tokens: 900, output_tokens: 120 }))
  const r = await runAutopilot(db, 'A', 'Acme', { ...gmail().d, providers: m.providers } as never)
  assert.equal(r.sent, 1); assert.equal(m.calls.length, 1)
  const ceiling = callCostUsd('claude-sonnet-4-5', Buffer.byteLength(m.calls[0].prompt), m.calls[0].max)
  const actual = (900 * 3 + 120 * 15) / 1e6
  assert.ok(ceiling > actual)
  assert.ok(Math.abs(pool(db)!.reserved_usd - actual) < 1e-9 && Math.abs(pool(db)!.reported_usd - actual) < 1e-9)

  // no cost reported: the worst case stays reserved
  const b = await launchedWithKey(5); lead(b.db, b.job, 'd@four.example')
  const silent = model('claude-sonnet-4-5', () => undefined)
  await runAutopilot(b.db, 'A', 'Acme', { ...gmail().d, providers: silent.providers } as never)
  assert.ok(Math.abs(pool(b.db)!.reserved_usd - callCostUsd('claude-sonnet-4-5', Buffer.byteLength(silent.calls[0].prompt), silent.calls[0].max)) < 1e-9)

  // the provider reports MORE than the estimate (cache writes): the overrun is recorded past the cap, and the next call is refused
  const c = await launchedWithKey(0.05); lead(c.db, c.job, 'd@four.example'); lead(c.db, c.job, 'e@five.example')
  const over = model('claude-sonnet-4-5', () => ({ input_tokens: 1000, output_tokens: 600, cache_creation_input_tokens: 40_000 }))
  const rc = await runAutopilot(c.db, 'A', 'Acme', { ...gmail().d, providers: over.providers } as never)
  assert.ok(pool(c.db)!.reserved_usd > 0.05, 'actual spend above the estimate is counted, even past the cap')
  assert.equal(rc.stopped, 'launch_spend_cap'); assert.equal(over.calls.length, 1, 'no further model call once the cap is used up')
})

test('HOLD: the cap, an unpriced model and an unreadable store all refuse the model call and stop the launch', async () => {
  // a cap smaller than one call's worst case: the call never happens
  const a = await launchedWithKey(0.001); lead(a.db, a.job, 'd@four.example')
  const m = model('claude-sonnet-4-5', () => ({ input_tokens: 10, output_tokens: 10 }))
  const g = gmail()
  const r = await runAutopilot(a.db, 'A', 'Acme', { ...g.d, providers: m.providers } as never)
  assert.deepEqual([r.stopped, m.calls.length, g.sent.length], ['launch_spend_cap', 0, 0])
  assert.equal(getState(a.db, 'A').pause_reason, 'launch_spend_cap')
  // a model with no listed price cannot be bounded: refused
  const b = await launchedWithKey(5); lead(b.db, b.job, 'd@four.example')
  const unpriced = model('some-new-model', () => ({ input_tokens: 10, output_tokens: 10 }))
  const rb = await runAutopilot(b.db, 'A', 'Acme', { ...gmail().d, providers: unpriced.providers } as never)
  assert.deepEqual([rb.stopped, unpriced.calls.length], ['model_unpriced', 0])
  // the shared store cannot record the reservation: refused
  const c = await launchedWithKey(5); lead(c.db, c.job, 'd@four.example')
  c.db.exec('DROP TABLE tenant_spend_pools')
  const mc = model('claude-sonnet-4-5', () => ({ input_tokens: 10, output_tokens: 10 }))
  const gc = gmail()
  const rc = await runAutopilot(c.db, 'A', 'Acme', { ...gc.d, providers: mc.providers } as never)
  assert.deepEqual([rc.stopped, mc.calls.length, gc.sent.length], ['spend_check_unavailable', 0, 0])
  // reservations are conditional on still fitting: once the cap is used, none fits for anyone
  const launchedAt = readLaunchPolicy(a.db, 'A')!.launchedAt!
  assert.equal(reserveLaunchSpend(a.db, 'A', launchedAt, 0.001, 0.002, NOW), 'over_cap')
  assert.equal(reserveLaunchSpend(a.db, 'A', launchedAt, 0.001, 0.001, NOW), 'ok')
  assert.equal(reserveLaunchSpend(a.db, 'A', launchedAt, 0.001, 0.0001, NOW), 'over_cap')
})

test('HOLD: a calibration bound to acceptance A cannot launch or touch a policy B accepted while it ran', async () => {
  for (const change of [{ audience: 'other' }, { sender: 'new@acme.example', testInbox: 'new@acme.example' }, { claims: { mayStatePrice: false, benchmarkUrls: [] } }] as const) {
    const db = await setup(); const job = play(db); for (const c of ['a@one.example', 'b@two.example', 'c@three.example']) lead(db, job, c)
    const otherJob = play(db)
    acceptLaunchPolicy(db, 'A', policy([job]), NOW)
    // hold the integration send open, and accept policy B while calibration for A is waiting on Gmail
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const g = gmail()
    const slow = { ...g.d, sendFn: (async (t: string, raw: string) => { await gate; return (g.d.sendFn as (t: string, r: string) => Promise<{ id: string }>)(t, raw) }) as never }
    const run = runCalibration(db, 'A', 'Acme', slow)
    await new Promise(r => setImmediate(r))
    const b = 'audience' in change ? policy([otherJob]) : policy([job], change as Record<string, unknown>)
    assert.deepEqual(acceptLaunchPolicy(db, 'A', b, NOW + 5), { ok: true })
    release()
    const r = await run
    assert.deepEqual(r, { ok: false, failures: ['policy_changed'], heldLeads: [] }, JSON.stringify(change))
    const after = readLaunchPolicy(db, 'A')!
    assert.equal(after.launchedAt, null, 'B was never calibrated, so it is not launched')
    assert.equal((db.prepare('SELECT preflight FROM autopilot_launch_policy').get() as { preflight: string | null }).preflight, null, "A's result is not written onto B")
    assert.deepEqual(after.policy, parsePolicy(b), 'B stays exactly as accepted')
    assert.equal(launchGate(db, 'A', 'me@acme.example', NOW + 6).calibrated, false)
  }
})

test('HOLD: a policy accepted while autopilot awaits a model call holds the draft: no send under the stale policy, no warmup fallback', async () => {
  const { db, job } = await launchedWithKey(5)
  const otherJob = play(db)
  lead(db, job, 'd@four.example')
  let release!: () => void
  const wait = new Promise<void>(r => { release = r })
  const base = model('claude-sonnet-4-5', () => ({ input_tokens: 10, output_tokens: 10 }))
  const slow: Provider = { ...base.providers.anthropic, completeDetailed: async (k, prompt, f, max) => { await wait; return base.providers.anthropic.completeDetailed!(k, prompt, f, max) } }
  const g = gmail()
  const run = runAutopilot(db, 'A', 'Acme', { ...g.d, providers: { anthropic: slow, openai: slow } } as never)
  await new Promise(r => setImmediate(r))
  // policy B: a different audience, accepted and not calibrated
  assert.deepEqual(acceptLaunchPolicy(db, 'A', policy([otherJob]), NOW + 1), { ok: true })
  release()
  const r = await run
  assert.deepEqual([r.sent, r.stopped, g.sent.length], [0, 'policy_changed', 0])
  assert.ok(recentAutopilotAudit(db, 'A').some(a => a.action === 'held_policy_changed'))
  assert.ok(!recentAutopilotAudit(db, 'A').some(a => a.action === 'held_warmup'), 'not silently moved to the warmup in this run either')
})

test('HOLD: a reported cost that cannot be recorded stops the launch before any further call or send', async () => {
  // the store rejects the settlement write
  const a = await launchedWithKey(0.05); lead(a.db, a.job, 'd@four.example'); lead(a.db, a.job, 'e@five.example')
  a.db.exec("CREATE TRIGGER no_settle BEFORE UPDATE OF reported_usd ON tenant_spend_pools BEGIN SELECT RAISE(ABORT, 'synthetic store failure'); END")
  const over = model('claude-sonnet-4-5', () => ({ input_tokens: 1000, output_tokens: 600, cache_creation_input_tokens: 40_000 }))
  const ga = gmail()
  const ra = await runAutopilot(a.db, 'A', 'Acme', { ...ga.d, providers: over.providers } as never)
  assert.deepEqual([ra.stopped, over.calls.length, ga.sent.length], ['spend_check_unavailable', 1, 0])
  assert.equal(getState(a.db, 'A').pause_reason, 'spend_check_unavailable')
  // the launch's row is gone by the time the cost comes back (zero rows updated)
  const b = await launchedWithKey(5); lead(b.db, b.job, 'd@four.example'); lead(b.db, b.job, 'e@five.example')
  const vanish = model('claude-sonnet-4-5', () => { b.db.exec('DELETE FROM tenant_spend_pools'); return { input_tokens: 10, output_tokens: 10 } })
  const gb = gmail()
  const rb = await runAutopilot(b.db, 'A', 'Acme', { ...gb.d, providers: vanish.providers } as never)
  assert.deepEqual([rb.stopped, vanish.calls.length, gb.sent.length], ['spend_check_unavailable', 1, 0])
})

test('HOLD: the send service rechecks the same acceptance after its token refresh, right before Gmail; unchanged policy still sends', async () => {
  const { db, job } = await launchedWithKey(5)
  const otherJob = play(db)
  lead(db, job, 'd@four.example')
  // policy B (another audience, uncalibrated) is accepted from inside the Gmail token refresh, after autopilot's own
  // post-drafting check and before the provider handoff
  const g = gmail()
  let swapped = false
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(url).includes('token') && !swapped) { swapped = true; acceptLaunchPolicy(db, 'A', policy([otherJob]), NOW + 1) }
    return (g.d.fetchImpl as typeof fetch)(url, init)
  }) as typeof fetch
  const r = await runAutopilot(db, 'A', 'Acme', { ...g.d, fetchImpl })
  assert.ok(swapped, 'the swap happened inside the send path')
  assert.deepEqual([r.sent, r.stopped, g.sent.length], [0, 'policy_changed', 0])
  const m = db.prepare("SELECT status, error FROM outreach_messages ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { status: string; error: string }
  assert.deepEqual(m, { status: 'draft', error: 'launch_policy_changed' }, 'back to a draft for the tenant, not left approved')
  assert.ok(!recentAutopilotAudit(db, 'A').some(a => a.action === 'held_warmup'))

  // the same path with the policy unchanged: the token refresh happens and the message is sent
  const b = await launchedWithKey(5); lead(b.db, b.job, 'd@four.example')
  const gb = gmail()
  let refreshed = 0
  const counting = (async (url: string, init?: RequestInit) => { if (String(url).includes('token')) refreshed++; return (gb.d.fetchImpl as typeof fetch)(url, init) }) as typeof fetch
  const rb = await runAutopilot(b.db, 'A', 'Acme', { ...gb.d, fetchImpl: counting })
  assert.ok(refreshed > 0); assert.deepEqual([rb.sent, gb.to()], [1, ['d@four.example']])
})

// ---------- the final send boundary (#405 review HOLD on 3571b7ee) ----------
// Everything autopilot requires in order to send is re-read from the store after the Gmail token refresh, immediately
// before the bytes go to Gmail (its sendAuthority). Each case below changes exactly one thing from inside that await: the
// policy's own stops (reply, bounce rate, an unreadable stop store), the tenant's switches (off, paused, consent, the
// operator kill flag), the cap, an uncertain send elsewhere, the launch itself (re-accepted, mailbox changed or gone).
// Each refuses the send with its specific reason, pauses when the stop is a pause, and releases the message to the
// tenant as a draft. The unchanged control sends exactly once. The service's own rechecks (suppression, the exact
// approved words, the recipient's lead) are unchanged and covered by the send suites.
async function launched() {
  const db = await setup(); const job = play(db); for (let i = 0; i < 3; i++) lead(db, job, `s${i}@cal${i}.example`)
  acceptLaunchPolicy(db, 'A', policy([job]), NOW)
  assert.equal((await runCalibration(db, 'A', 'Acme', gmail().d)).ok, true)
  lead(db, job, 'd@four.example')
  return { db, job }
}
// one autopilot pass whose first Gmail token refresh applies `change` to the store before answering
async function duringRefresh(db: Database.Database, change: (flags: Record<string, string>) => void) {
  const g = gmail(); const flags = { ...ON }
  let changed = false
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(url).includes('token') && !changed) { changed = true; change(flags) }
    return (g.d.fetchImpl as typeof fetch)(url, init)
  }) as typeof fetch
  const r = await runAutopilot(db, 'A', 'Acme', { ...g.d, fetchImpl, flags, now: NOW + 2 })
  assert.ok(changed, 'the change happened inside the send path')
  const m = db.prepare("SELECT status, error FROM outreach_messages WHERE to_email = 'd@four.example'").get() as { status: string; error: string | null }
  const st = getState(db, 'A')
  return { sent: g.sent.length, run: [r.sent, r.stopped ?? null], msg: [m.status, m.error], pause: st.paused ? st.pause_reason : null, warmup: recentAutopilotAudit(db, 'A').some(a => a.action === 'held_warmup') }
}
type Case = { change: (db: Database.Database, flags: Record<string, string>) => void; stopped: string | null; pause: string | null; msg: [string, string | null] }
const boundaryCases: Record<string, Case> = {
  // the accepted policy's own stops (pauseOnAnyReply: true, maxBounceRate: 0.05)
  reply_received: { change: db => db.prepare("INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at) VALUES ('r1', 'A', 't1', NULL, 's0@cal0.example', 'thanks', 'positive', ?)").run(NOW + 1), stopped: 'reply_received', pause: 'reply_received', msg: ['draft', 'reply_received'] },
  bounce_rate: { change: db => auditAt(db, 'A', 'bounce', 'gone@co9.example', undefined, undefined, NOW + 1), stopped: 'bounce_rate', pause: 'bounce_rate', msg: ['draft', 'bounce_rate'] },
  stop_check_unavailable: { change: db => db.exec('DROP TABLE inbound_messages'), stopped: 'stop_check_unavailable', pause: 'stop_check_unavailable', msg: ['draft', 'stop_check_unavailable'] },
  // the tenant's own switches and the operator's
  disabled: { change: db => disable(db, 'A'), stopped: 'off', pause: null, msg: ['draft', 'off'] },
  paused: { change: db => pause(db, 'A'), stopped: 'paused', pause: 'paused_by_user', msg: ['draft', 'paused'] },
  kill_flag: { change: (_db, flags) => { flags.AUTOPILOT_KILL = '1' }, stopped: 'not_available', pause: null, msg: ['draft', 'not_available'] },
  consent_replaced: { change: db => db.prepare("UPDATE autopilot_settings SET consent_version = '2000-01-01' WHERE tenant_id = 'A'").run(), stopped: 'consent_required', pause: null, msg: ['draft', 'consent_required'] },
  // volume and an uncertain send elsewhere
  daily_cap_lowered: { change: db => db.prepare("UPDATE autopilot_settings SET daily_cap = 1 WHERE tenant_id = 'A'").run(), stopped: 'daily_cap', pause: null, msg: ['draft', 'daily_cap'] },
  uncertain_elsewhere: { change: db => db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, claimed_at) VALUES ('u1a2b3c4d5e6f7a8b9c0d1e2', 'A', 'xu', 'u@other.example', 's', 'bodybodybodybodybodybody', 'uncertain', ?)").run(NOW), stopped: 'uncertain_send', pause: 'uncertain_send', msg: ['draft', 'uncertain_send'] },
  // the launch itself: the same policy accepted again (a new acceptance, launch cleared), the mailbox changed or gone
  policy_reaccepted: { change: db => { assert.deepEqual(acceptLaunchPolicy(db, 'A', policy([(db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id]), NOW + 1), { ok: true }) }, stopped: 'policy_changed', pause: null, msg: ['draft', 'launch_policy_changed'] },
  mailbox_changed: { change: db => db.prepare("UPDATE gmail_accounts SET email = 'other@acme.example' WHERE tenant_id = 'A'").run(), stopped: 'policy_changed', pause: null, msg: ['draft', 'launch_policy_changed'] },
  mailbox_disconnected: { change: db => db.prepare("DELETE FROM gmail_accounts WHERE tenant_id = 'A'").run(), stopped: 'policy_changed', pause: null, msg: ['draft', 'launch_policy_changed'] },
}

test('HOLD: every stop is re-read after the token refresh, right before Gmail: no send, the specific reason, the message released', async () => {
  const got: Record<string, unknown> = {}, want: Record<string, unknown> = {}
  for (const [name, c] of Object.entries(boundaryCases)) {
    const { db } = await launched()
    if (name === 'daily_cap_lowered') auditAt(db, 'A', 'sent', undefined, undefined, undefined, NOW - 100) // one autopilot send already today
    got[name] = await duringRefresh(db, flags => c.change(db, flags))
    want[name] = { sent: 0, run: [0, c.stopped], msg: c.msg, pause: c.pause, warmup: false }
  }
  assert.deepEqual(got, want)
})

test('HOLD: a hand send is refused at the same boundary when autopilot is paused during its token refresh', async () => {
  const { db } = await launched()
  const leadId = (db.prepare("SELECT id FROM leads WHERE contact = 'd@four.example'").get() as { id: string }).id
  const id = createDraft(db, 'A', leadId, 'Acme'); approve(db, 'A', id)
  const g = gmail()
  const fetchImpl = (async (url: string, init?: RequestInit) => { if (String(url).includes('token')) pause(db, 'A'); return (g.d.fetchImpl as typeof fetch)(url, init) }) as typeof fetch
  await assert.rejects(sendMessage(db, 'A', id, { ...g.d, fetchImpl, now: NOW + 2 }), (e: unknown) => e instanceof OutreachError && e.code === 'paused')
  assert.equal(g.sent.length, 0)
  assert.deepEqual(db.prepare('SELECT status, error FROM outreach_messages WHERE id = ?').get(id), { status: 'approved', error: 'paused' }, 'a hand approval stays the tenant\'s, released with the reason')
})

test('HOLD: a sendAuthority that cannot answer is a refusal: the claim is released with stop_check_unavailable, nothing sent', async () => {
  // at the claim, and separately only at the handoff after the token refresh: either way the message never stays 'sending'
  for (const failAt of [1, 2]) {
    const { db } = await launched()
    const leadId = (db.prepare("SELECT id FROM leads WHERE contact = 'd@four.example'").get() as { id: string }).id
    const id = createDraft(db, 'A', leadId, 'Acme'); approve(db, 'A', id)
    const g = gmail(); let calls = 0
    const sendAuthority = () => { calls++; if (calls === failAt) throw new Error('stop store unreadable'); return null }
    await assert.rejects(sendMessage(db, 'A', id, { ...g.d, sendAuthority, now: NOW + 2 }), (e: unknown) => e instanceof OutreachError && e.code === 'stop_check_unavailable', `throws at call ${failAt}`)
    assert.equal(calls, failAt)
    assert.equal(g.sent.length, 0)
    assert.deepEqual(db.prepare('SELECT status, error FROM outreach_messages WHERE id = ?').get(id), { status: 'approved', error: 'stop_check_unavailable' })
  }
})

test('HOLD: unchanged state at the same boundary sends exactly once; two competing passes never send a lead twice', async () => {
  const { db } = await launched()
  const got = await duringRefresh(db, () => {})
  assert.deepEqual(got, { sent: 1, run: [1, null], msg: ['sent', null], pause: null, warmup: false })

  const b = await launched(); lead(b.db, b.job, 'e@five.example')
  const g1 = gmail(), g2 = gmail()
  const [r1, r2] = await Promise.all([runAutopilot(b.db, 'A', 'Acme', { ...g1.d, now: NOW + 2 }), runAutopilot(b.db, 'A', 'Acme', { ...g2.d, now: NOW + 2 })])
  const to = [...g1.to(), ...g2.to()].sort()
  assert.deepEqual(to, ['d@four.example', 'e@five.example'], 'each lead is sent exactly once across both passes')
  assert.equal(r1.sent + r2.sent, 2)
  assert.deepEqual(statuses(b.db).filter(s => s !== 'draft'), ['sent', 'sent'])
})
