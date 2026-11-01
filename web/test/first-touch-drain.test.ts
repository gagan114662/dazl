import { seedOffers } from './helpers/seed-offer.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { completeOAuth, startOAuth, GmailSendError } from '../lib/gmail/oauth.ts'
import { saveSettings, sendMessage, approve, type Deps } from '../lib/outreach/service.ts'
import { saveMemory } from '../lib/memory.ts'
import { ATTESTATIONS, CONSENT_VERSION, drainFirstTouch, enable, getState, offerHashFor, migrateAutopilot, pause, resume, disable, runAutopilot } from '../lib/outreach/autopilot.ts'

const master = randomBytes(32)
const genv = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const ON = { AUTOPILOT_ENABLED: '1', AUTOPILOT_WARMUP: '2' }
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
const tokenOk = (async (url: string) => (String(url).includes('token') ? json({ access_token: 'at' }) : json({}, 404))) as unknown as typeof fetch
const tokenDown = (async () => { throw new Error('network') }) as unknown as typeof fetch

async function setup(file?: string) {
  const db = new Database(file ?? ':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); seedOffers(db)
  const state = new URL(startOAuth(db, 'A', { env: genv, now: NOW })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', state, { env: genv, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: 'https://www.googleapis.com/auth/gmail.send', id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
  saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  return db
}
function lead(db: Database.Database, contact: string | null, conf: number | null = 90, ev: string | null = 'Co is hiring') {
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const id = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, job, 'Co ' + id.slice(0, 4), contact, 'Hiring roofers', 'https://n.example/a', ev, conf, 80)
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE confidence IS NOT NULL AND evidence_excerpt IS NOT NULL").run()
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job) // finished: its gates have run; only leads of a done scan are autopilot's candidates
  return id
}
const ok = (db: Database.Database) => enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 3 })
// Two old warmup sends (outside every cap window), so the manual warmup gate is cleared.
const warmed = (db: Database.Database) => db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES ('s1a2b3c4d5e6f7a8b9c0d1e2','A','x1','o1@z.example','s','bodybodybodybodybodybody','sent',?,?),('s2a2b3c4d5e6f7a8b9c0d1e2','A','x2','o2@z.example','s','bodybodybodybodybodybody','sent',?,?)").run(NOW - 9e5, NOW - 9e5, NOW - 9e5, NOW - 9e5)
type SendStub = { calls: string[]; d: Deps & { flags: Record<string, string> }; fail: (e: unknown) => void; heal: () => void }
const sendStub = (now: number, firstError?: unknown): SendStub => {
  const calls: string[] = []
  let failure: unknown = firstError
  const d: Deps & { flags: Record<string, string> } = { flags: ON, env: genv, master, now, baseUrl: 'https://app.test', fetchImpl: tokenOk, sendFn: (async (_t: string, raw: string) => { calls.push(raw); if (failure) throw failure; return { id: 'g' } }) as never }
  return { calls, d, fail: (e) => { failure = e }, heal: () => { failure = null } }
}
const rows = (db: Database.Database) => db.prepare('SELECT id, to_email, status, attempts, claimed_at, hold_reason, hold_until, hold_policy, error FROM outreach_messages ORDER BY created_at, rowid').all() as { id: string; to_email: string; status: string; attempts: number; claimed_at: number | null; hold_reason: string | null; hold_until: number | null; hold_policy: string | null; error: string | null }[]
const nonWarmup = (db: Database.Database) => rows(db).filter(r => !r.to_email.endsWith('@z.example'))

test('daily cap: the 4th first touch is never drafted early, sends at the window roll, no new scan', async () => {
  const db = await setup(); ok(db); warmed(db)
  const s1 = sendStub(NOW)
  for (const e of ['a@one.example', 'b@two.example', 'c@three.example', 'd@four.example']) lead(db, e)
  const r = await runAutopilot(db, 'A', 'Acme', s1.d) // cap 3: three send
  assert.equal(r.sent, 3)
  // #411's fix: the 4th is drafted but held as first-touch WORK with its authority fingerprint, due at the window
  // roll - not stranded by the NOT EXISTS candidacy rule that lost every held draft before.
  const held = nonWarmup(db).find(m => m.to_email === 'd@four.example')!
  assert.equal(held.status, 'draft')
  const work = db.prepare("SELECT reason, next_at, authority FROM autopilot_work WHERE message_id = ? AND tenant_id = 'A'").get(held.id) as { reason: string; next_at: number; authority: string }
  assert.equal(work.reason, 'daily_cap'); assert.ok(work.next_at > NOW && work.next_at <= NOW + 86401)
  assert.ok(work.authority.length === 64, 'the hold carries its authority fingerprint')
  // Same day: the held work is not due; another pass sends nothing and drafts nothing new.
  const again = await runAutopilot(db, 'A', 'Acme', s1.d)
  assert.equal(again.sent, 0); assert.equal(s1.calls.length, 3)
  assert.equal(nonWarmup(db).filter(m => m.to_email === 'd@four.example').length, 1)
  // At the window roll: exactly one send of the same draft, no scan, no double-send on a second pass.
  const s2 = sendStub(NOW + 86401)
  const d1 = await runAutopilot(db, 'A', 'Acme', s2.d)
  assert.equal(d1.sent, 1); assert.equal(s2.calls.length, 1)
  assert.equal(nonWarmup(db).find(m => m.to_email === 'd@four.example')!.status, 'sent')
  const d2 = await runAutopilot(db, 'A', 'Acme', s2.d)
  assert.equal(d2.sent, 0); assert.equal(s2.calls.length, 1)
  assert.equal(nonWarmup(db).filter(m => m.status === 'sent').length, 4)
})

test('legacy bridge: a pre-merge daily_cap hold on outreach_messages still drains exactly once at its due time', async () => {
  const db = await setup(); ok(db); warmed(db)
  const leadId = lead(db, 'd@four.example')
  const id = randomBytes(12).toString('hex')
  // The row a pre-merge store could carry: drafted under the current policy, held at the cap. The migration must not strand it.
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, hold_reason, hold_until, hold_policy, offer_hash) VALUES (?, 'A', ?, 'd@four.example', 's', 'bodybodybodybodybodybody', 'draft', 'daily_cap', ?, ?, ?)")
    .run(id, leadId, NOW + 3600, CONSENT_VERSION, offerHashFor(db, 'A', leadId))
  const early = await drainFirstTouch(db, 'A', sendStub(NOW).d) // not due yet: nothing goes out
  assert.equal(early.sent, 0)
  const s2 = sendStub(NOW + 86401)
  const d1 = await drainFirstTouch(db, 'A', s2.d)
  assert.equal(d1.sent, 1); assert.equal(s2.calls.length, 1)
  assert.equal(nonWarmup(db).find(m => m.to_email === 'd@four.example')!.status, 'sent')
  const d2 = await drainFirstTouch(db, 'A', s2.d)
  assert.equal(d2.sent, 0); assert.equal(s2.calls.length, 1)
})

test('domain cap: the second first touch to a company holds as work and sends after seven days', async () => {
  const db = await setup(); ok(db); warmed(db)
  const s1 = sendStub(NOW)
  lead(db, 'a@one.example'); lead(db, 'b@one.example')
  const r = await runAutopilot(db, 'A', 'Acme', s1.d)
  assert.equal(r.sent, 1); assert.equal(r.held, 1)
  const held = nonWarmup(db).find(m => m.to_email === 'b@one.example')!
  assert.equal(held.status, 'draft')
  const work = db.prepare("SELECT reason, next_at FROM autopilot_work WHERE message_id = ? AND tenant_id = 'A'").get(held.id) as { reason: string; next_at: number }
  assert.equal(work.reason, 'domain_cap'); assert.ok(work.next_at > NOW + 7 * 86400, 'due after the seven-day company rule')
  // Six days in: not due; nothing goes out.
  const mid = await runAutopilot(db, 'A', 'Acme', sendStub(NOW + 6 * 86400).d)
  assert.equal(mid.sent, 0)
  // After seven days: the held draft sends, exactly once, no new scan.
  const s2 = sendStub(NOW + 7 * 86400 + 1)
  const d = await runAutopilot(db, 'A', 'Acme', s2.d)
  assert.equal(d.sent, 1); assert.equal(s2.calls.length, 1)
  assert.equal(nonWarmup(db).find(m => m.to_email === 'b@one.example')!.status, 'sent')
})

test('warmup drafts and pre-existing no-hold drafts are never auto-sent, by the drain or a pass', async () => {
  const db = await setup(); ok(db) // no warmup rows: the first drafts stay manual
  const s1 = sendStub(NOW)
  lead(db, 'a@one.example')
  const r = await runAutopilot(db, 'A', 'Acme', s1.d)
  assert.equal(r.held, 1); assert.equal(r.sent, 0)
  const warm = nonWarmup(db).find(m => m.to_email === 'a@one.example')!
  assert.equal(warm.status, 'draft')
  const wwork = db.prepare("SELECT reason, next_at FROM autopilot_work WHERE message_id = ? AND tenant_id = 'A'").get(warm.id) as { reason: string; next_at: number | null }
  assert.equal(wwork.reason, 'warmup'); assert.equal(wwork.next_at, null, 'never due: the user approves it (#411: warmup drafts stay manual)')
  // A pre-existing draft with no hold record (created before the backlog existed): no work row, and its lead is out
  // of candidacy (it has a message row), so neither the drain nor a pass may ever send it.
  const leadB = lead(db, 'b@two.example')
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES ('l1a2b3c4d5e6f7a8b9c0d1e2','A',?,'b@two.example','s','bodybodybodybodybodybody','draft')").run(leadB)
  warmed(db) // clear the warmup gate: even then, neither draft may go out
  const s2 = sendStub(NOW + 90 * 86400)
  const d = await drainFirstTouch(db, 'A', s2.d)
  assert.equal(d.sent, 0)
  const p = await runAutopilot(db, 'A', 'Acme', s2.d)
  assert.equal(p.sent, 0); assert.equal(s2.calls.length, 0)
  assert.deepEqual(nonWarmup(db).map(m => m.status), ['draft', 'draft'])
})

test('reconnect resumes eligible held work without a new scan', async () => {
  const db = await setup(); ok(db); warmed(db)
  const s1 = sendStub(NOW)
  lead(db, 'a@one.example'); lead(db, 'b@one.example')
  await runAutopilot(db, 'A', 'Acme', s1.d) // one sent, one domain-held
  const now2 = NOW + 7 * 86400 + 1
  const s2 = sendStub(now2, new GmailSendError(401))
  const d1 = await runAutopilot(db, 'A', 'Acme', s2.d)
  assert.equal(d1.sent, 0); assert.ok(s2.calls.length <= 1, 'at most the one refused attempt')
  const m = nonWarmup(db).find(x => x.to_email === 'b@one.example')!
  assert.notEqual(m.status, 'sent') // never sent while Gmail refused
  assert.ok(db.prepare("SELECT 1 FROM autopilot_work WHERE message_id = ? AND tenant_id = 'A'").get(m.id), 'the work stays due for the first pass after reconnect')
  // User reconnects and resumes: the next pass sends the still-eligible draft, no new scan.
  db.prepare("UPDATE gmail_accounts SET status = 'active' WHERE tenant_id = 'A'").run()
  resume(db, 'A')
  const s3 = sendStub(now2 + 60)
  const d2 = await runAutopilot(db, 'A', 'Acme', s3.d)
  assert.equal(d2.sent, 1); assert.equal(s3.calls.length, 1)
  assert.equal(nonWarmup(db).find(x => x.to_email === 'b@one.example')!.status, 'sent')
})

test('pause and disable stop the drain; consent from another version is never acted on', async () => {
  const db = await setup(); ok(db); warmed(db)
  const s1 = sendStub(NOW)
  for (const e of ['a@one.example', 'b@two.example', 'c@three.example', 'd@four.example']) lead(db, e)
  await runAutopilot(db, 'A', 'Acme', s1.d) // d@four held on daily cap
  const now2 = NOW + 86401
  pause(db, 'A')
  const s2 = sendStub(now2)
  assert.equal((await drainFirstTouch(db, 'A', s2.d)).stopped, 'paused'); assert.equal(s2.calls.length, 0)
  resume(db, 'A'); disable(db, 'A')
  assert.equal((await drainFirstTouch(db, 'A', s2.d)).stopped, 'off'); assert.equal(s2.calls.length, 0)
  db.prepare("UPDATE autopilot_settings SET enabled = 1, paused = 0, consent_version = '1900-01-01' WHERE tenant_id = 'A'").run()
  assert.equal((await drainFirstTouch(db, 'A', s2.d)).stopped, 'consent_required'); assert.equal(s2.calls.length, 0)
  // A hold recorded under an older consent version is never drained even after re-consent.
  db.prepare("UPDATE autopilot_settings SET consent_version = ? WHERE tenant_id = 'A'").run(CONSENT_VERSION)
  db.prepare("UPDATE outreach_messages SET hold_policy = '1900-01-01' WHERE to_email = 'd@four.example'").run()
  assert.equal((await drainFirstTouch(db, 'A', s2.d)).sent, 0); assert.equal(s2.calls.length, 0)
})

test('changed offer invalidates the authority: the held draft is skipped, never sent', async () => {
  const db = await setup(); ok(db); warmed(db)
  const s1 = sendStub(NOW)
  lead(db, 'a@one.example'); lead(db, 'b@one.example')
  await runAutopilot(db, 'A', 'Acme', s1.d)
  saveMemory(db, 'A', { positioning: 'A completely different offer now.' })
  const s2 = sendStub(NOW + 7 * 86400 + 1)
  const d = await runAutopilot(db, 'A', 'Acme', s2.d)
  assert.equal(d.sent, 0); assert.equal(s2.calls.length, 0) // changed authority: never sent, no attempt
  const m = nonWarmup(db).find(x => x.to_email === 'b@one.example')!
  assert.equal(m.status, 'draft') // back to the user, unapproved - the held authority is gone
  assert.equal((db.prepare("SELECT count(*) AS n FROM autopilot_work WHERE message_id = ? AND tenant_id = 'A'").get(m.id) as { n: number }).n, 0, 'released from the queue')
  // And it stays the user's: no later pass revives it (the lead has a message row, no work row).
  const d2 = await runAutopilot(db, 'A', 'Acme', sendStub(NOW + 8 * 86400).d)
  assert.equal(d2.sent, 0)
})

test('failure matrix: timeout, transport error and malformed success become uncertain, pause and are never retried', async () => {
  for (const failure of [new Error('network timeout'), new TypeError('fetch failed'), {} as unknown as Error]) {
    const db = await setup(); ok(db); warmed(db)
    const s1 = sendStub(NOW)
    lead(db, 'a@one.example'); lead(db, 'b@one.example')
    await runAutopilot(db, 'A', 'Acme', s1.d)
    const now2 = NOW + 7 * 86400 + 1
    const s2 = sendStub(now2, failure)
    const d1 = await runAutopilot(db, 'A', 'Acme', s2.d)
    assert.equal(d1.sent, 0)
    assert.equal(getState(db, 'A').paused, true, 'an ambiguous outcome pauses the tenant')
    const m = nonWarmup(db).find(x => x.to_email === 'b@one.example')!
    assert.equal(m.status, 'uncertain', 'ambiguous outcome: never known-sent, never retried (#411)')
    // After the user resumes, the uncertain message is still never retried; the pass refuses to run while it stands.
    resume(db, 'A')
    const s3 = sendStub(now2 + 60)
    const d2 = await runAutopilot(db, 'A', 'Acme', s3.d)
    assert.equal(d2.sent, 0); assert.equal(s3.calls.length, 0)
    assert.equal(nonWarmup(db).find(x => x.to_email === 'b@one.example')!.status, 'uncertain')
  }
})

test('proven refusals: 429 is re-held without send and delivered at its due time; 400 is skipped permanently', async () => {
  const db = await setup(); ok(db); warmed(db)
  const s1 = sendStub(NOW)
  lead(db, 'a@one.example'); lead(db, 'b@one.example')
  await runAutopilot(db, 'A', 'Acme', s1.d)
  const now2 = NOW + 7 * 86400 + 1
  const s2 = sendStub(now2, new GmailSendError(429))
  const d1 = await runAutopilot(db, 'A', 'Acme', s2.d)
  assert.equal(d1.sent, 0); assert.equal(d1.held, 1); assert.equal(s2.calls.length, 1) // one attempt, known not sent
  const m = () => nonWarmup(db).find(x => x.to_email === 'b@one.example')!
  assert.equal(m().status, 'draft') // back to unapproved while it waits
  const work = db.prepare("SELECT reason, next_at, attempts FROM autopilot_work WHERE message_id = ? AND tenant_id = 'A'").get(m().id) as { reason: string; next_at: number; attempts: number }
  assert.equal(work.reason, 'gmail_rate_limited'); assert.equal(work.attempts, 1)
  assert.ok(work.next_at > now2 && work.next_at <= now2 + 7200, 'bounded backoff, not a busy loop')
  const s3 = sendStub(work.next_at + 1)
  const d2 = await runAutopilot(db, 'A', 'Acme', s3.d)
  assert.equal(d2.sent, 1); assert.equal(s3.calls.length, 1)
  // 400: Gmail refused the message itself; never retried.
  const db2 = await setup(); ok(db2); warmed(db2)
  const t1 = sendStub(NOW)
  lead(db2, 'a@one.example'); lead(db2, 'b@one.example')
  await runAutopilot(db2, 'A', 'Acme', t1.d)
  const t2 = sendStub(NOW + 7 * 86400 + 1, new GmailSendError(400))
  const r1 = await runAutopilot(db2, 'A', 'Acme', t2.d)
  assert.equal(r1.sent, 0); assert.equal(t2.calls.length, 1) // refused before send: the one attempt, known not sent
  const m2 = () => nonWarmup(db2).find(x => x.to_email === 'b@one.example')!
  assert.equal(m2().status, 'draft') // back to the user, unapproved - Gmail refused the message itself
  assert.equal((db2.prepare("SELECT count(*) AS n FROM autopilot_work WHERE message_id = ? AND tenant_id = 'A'").get(m2().id) as { n: number }).n, 0, 'out of the queue: never retried')
  const t3 = sendStub(NOW + 8 * 86400)
  assert.equal((await runAutopilot(db2, 'A', 'Acme', t3.d)).sent, 0); assert.equal(t3.calls.length, 0)
})

test('gmail_unavailable never reaches Gmail: no send request is made, the draft is held and later delivered', async () => {
  const db = await setup(); ok(db); warmed(db)
  const s1 = sendStub(NOW)
  lead(db, 'a@one.example'); lead(db, 'b@one.example')
  await runAutopilot(db, 'A', 'Acme', s1.d)
  const now2 = NOW + 7 * 86400 + 1
  const calls: string[] = []
  const d2h: Deps & { flags: Record<string, string> } = { flags: ON, env: genv, master, now: now2, baseUrl: 'https://app.test', fetchImpl: tokenDown, sendFn: (async (_t: string, raw: string) => { calls.push(raw); return { id: 'g' } }) as never }
  const d1 = await runAutopilot(db, 'A', 'Acme', d2h)
  assert.equal(d1.sent, 0); assert.equal(d1.held, 1)
  assert.equal(calls.length, 0) // token failure precedes any send request
  const m = nonWarmup(db).find(x => x.to_email === 'b@one.example')!
  assert.equal(m.status, 'draft')
  const w = db.prepare("SELECT reason, next_at, attempts FROM autopilot_work WHERE message_id = ? AND tenant_id = 'A'").get(m.id) as { reason: string; next_at: number; attempts: number }
  assert.equal(w.reason, 'gmail_unavailable'); assert.equal(w.attempts, 1); assert.ok(w.next_at > now2)
  const s3 = sendStub(w.next_at + 1)
  const d2 = await runAutopilot(db, 'A', 'Acme', s3.d)
  assert.equal(d2.sent, 1); assert.equal(s3.calls.length, 1)
})

test('bounded retries: persistent 429 exhausts to skipped, never loops forever', async () => {
  const db = await setup(); ok(db); warmed(db)
  const s1 = sendStub(NOW)
  lead(db, 'a@one.example'); lead(db, 'b@one.example')
  await runAutopilot(db, 'A', 'Acme', s1.d)
  let now = NOW + 7 * 86400 + 1
  for (let i = 0; i < 2; i++) {
    const s = sendStub(now, new GmailSendError(429))
    const r = await runAutopilot(db, 'A', 'Acme', s.d)
    assert.equal(r.held, 1); assert.equal(r.sent, 0)
    const m = nonWarmup(db).find(x => x.to_email === 'b@one.example')!
    assert.equal(m.status, 'draft')
    const w = db.prepare("SELECT next_at, attempts FROM autopilot_work WHERE message_id = ? AND tenant_id = 'A'").get(m.id) as { next_at: number; attempts: number }
    assert.equal(w.attempts, i + 1, 'bounded attempts, growing backoff')
    now = w.next_at + 1
  }
  // The third refusal exhausts the bounded retries: out of the queue, the user decides - never a silent skip, never a loop.
  const s = sendStub(now, new GmailSendError(429))
  const r = await runAutopilot(db, 'A', 'Acme', s.d)
  assert.equal(r.sent, 0)
  const m = nonWarmup(db).find(x => x.to_email === 'b@one.example')!
  assert.equal(m.status, 'draft')
  assert.equal((db.prepare("SELECT count(*) AS n FROM autopilot_work WHERE message_id = ? AND tenant_id = 'A'").get(m.id) as { n: number }).n, 0, 'exhausted: out of the queue')
  const s2 = sendStub(now + 30 * 86400)
  assert.equal((await runAutopilot(db, 'A', 'Acme', s2.d)).sent, 0); assert.equal(s2.calls.length, 0)
})

test('account daily cap: re-held at the window edge without consuming retries, sent when the window rolls', async () => {
  const db = await setup(); warmed(db)
  // The tenant policy cap sits ABOVE the account's rolling cap (ACCOUNT_SEND_CAP = 20), so only the account-level
  // refusal in sendClaimed (service.ts) can hold this send - the path this leg proves never consumes retries.
  enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 25 })
  const s1 = sendStub(NOW)
  lead(db, 'a@one.example'); lead(db, 'b@one.example')
  await runAutopilot(db, 'A', 'Acme', s1.d) // a sends; b is same-domain, held by the 7-day company rule
  const now2 = NOW + 7 * 86400 + 1
  // Fill the account-level rolling window at its edge.
  for (let i = 0; i < 20; i++) db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES (?, 'A', ?, ?, 's', 'bodybodybodybodybodybody', 'sent', ?, ?)").run('cap' + String(i).padStart(21, '0'), 'caplead' + i, `cap${i}@cap.example`, now2 - 3600, now2 - 3600)
  const s2 = sendStub(now2)
  let w2 = { next_at: now2 }
  for (let i = 0; i < 3; i++) { // a legitimate cap never exhausts the draft's bounded retries
    const r = await runAutopilot(db, 'A', 'Acme', s2.d)
    assert.equal(r.sent, 0)
    assert.equal(r.stopped, 'daily_cap', 'the pass stops at a full account window: every later send this tick would hit it')
    const m = nonWarmup(db).find(x => x.to_email === 'b@one.example')!
    assert.equal(m.status, 'draft')
    const w = db.prepare("SELECT reason, next_at, attempts FROM autopilot_work WHERE message_id = ? AND tenant_id = 'A'").get(m.id) as { reason: string; next_at: number; attempts: number }
    assert.equal(w.reason, 'daily_cap')
    assert.equal(w.attempts, 0, 'a cap refusal is capacity, not a send fault: bounded retries are never consumed')
    assert.ok(w.next_at > now2, 'still queued, due at the window roll: cap waits never reach the exhaustion path')
    w2 = w
    db.prepare("UPDATE autopilot_work SET next_at = ? WHERE message_id = ? AND tenant_id = 'A'").run(now2, m.id) // force re-due as if the edge passed; the cap is still full
  }
  // Window rolls: the cap-held draft sends without any retry-exhaustion.
  const past = w2.next_at + 1
  db.prepare("UPDATE outreach_messages SET claimed_at = ?, sent_at = ? WHERE to_email LIKE 'cap%@cap.example'").run(past - 90000, past - 90000)
  const s3 = sendStub(past)
  const r = await runAutopilot(db, 'A', 'Acme', s3.d)
  assert.equal(r.sent, 1); assert.equal(s3.calls.length, 1)
})

test('mixed store restart: a legacy outreach_messages hold and a new autopilot_work hold both survive and drain exactly once, each on its own path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dazl-mixed-'))
  try {
    const file = join(dir, 't.sqlite')
    const db = await setup(file); ok(db); warmed(db)
    const s1 = sendStub(NOW)
    lead(db, 'a@one.example'); lead(db, 'b@one.example')
    await runAutopilot(db, 'A', 'Acme', s1.d) // a sends; b held by the 7-day company rule (new model work row)
    // A pre-merge daily_cap hold coexists on the same store: the migration must not strand either kind.
    const legacyLead = lead(db, 'd@four.example')
    const legacyId = randomBytes(12).toString('hex')
    db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, hold_reason, hold_until, hold_policy, offer_hash) VALUES (?, 'A', ?, 'd@four.example', 's', 'bodybodybodybodybodybody', 'draft', 'daily_cap', ?, ?, ?)")
      .run(legacyId, legacyLead, NOW + 3600, CONSENT_VERSION, offerHashFor(db, 'A', legacyLead))
    db.close()
    // Restart: reopen the same file (migrations re-run idempotently on the existing schema).
    const db2 = new Database(file); migrateScan(db2); migrateOutreach(db2); migrateConnectors(db2); migrateAutopilot(db2)
    const due = NOW + 7 * 86400 + 1
    const s2 = sendStub(due)
    const r = await runAutopilot(db2, 'A', 'Acme', s2.d)
    assert.equal(r.sent, 1, 'the new-model hold drains on its path')
    const d1 = await drainFirstTouch(db2, 'A', s2.d)
    assert.equal(d1.sent, 1, 'the legacy hold drains on its path')
    assert.equal(s2.calls.length, 2, 'exactly one provider call per hold across both paths')
    // A second round sends nothing: neither hold re-fires after the restart.
    const r2 = await runAutopilot(db2, 'A', 'Acme', sendStub(due + 60).d)
    const d2 = await drainFirstTouch(db2, 'A', sendStub(due + 60).d)
    assert.equal(r2.sent + d2.sent, 0)
    db2.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('concurrent ticks: two passes over a due hold send it exactly once', async () => {
  const db = await setup(); ok(db); warmed(db)
  const s1 = sendStub(NOW)
  lead(db, 'a@one.example'); lead(db, 'b@one.example')
  await runAutopilot(db, 'A', 'Acme', s1.d) // b domain-held until +7d
  const due = NOW + 7 * 86400 + 1
  const calls: string[] = []
  const d = () => { const s = sendStub(due); const inner = s.d.sendFn as (t: string, raw: string) => Promise<unknown>; s.d.sendFn = (async (t: string, raw: string) => { const r = await inner(t, raw); calls.push(raw); return r }) as never; return s.d }
  const [r1, r2] = await Promise.all([runAutopilot(db, 'A', 'Acme', d()), runAutopilot(db, 'A', 'Acme', d())])
  assert.equal(r1.sent + r2.sent, 1, 'exactly one pass sends the due hold')
  assert.equal(calls.length, 1, 'exactly one provider call')
  assert.equal(nonWarmup(db).find(x => x.to_email === 'b@one.example')!.status, 'sent')
})

test('claim conflict: a loser tick never rewrites, consumes attempts, or releases the winner claim', async () => {
  const db = await setup(); ok(db); warmed(db)
  const s1 = sendStub(NOW)
  lead(db, 'a@one.example'); lead(db, 'b@one.example')
  await runAutopilot(db, 'A', 'Acme', s1.d)
  const due = NOW + 7 * 86400 + 1
  // Winner claims the due draft (status sending, attempt counted).
  const m = nonWarmup(db).find(x => x.to_email === 'b@one.example')!
  approve(db, 'A', m.id)
  const pending = sendMessage(db, 'A', m.id, { ...sendStub(due).d, sendFn: (async () => new Promise(() => {})) as never }) // never resolves: the send is in flight
  void pending.catch(() => {})
  await new Promise(r => setTimeout(r, 50))
  const mid = nonWarmup(db).find(x => x.to_email === 'b@one.example')!
  assert.equal(mid.status, 'sending'); assert.equal(mid.attempts, 1); assert.equal(mid.claimed_at, due)
  // Loser tick: the in-flight row is never selected; a direct competing send throws already_sending and writes nothing.
  const s2 = sendStub(due)
  const d1 = await drainFirstTouch(db, 'A', s2.d)
  assert.equal(d1.sent, 0); assert.equal(d1.held, 0); assert.equal(s2.calls.length, 0)
  await assert.rejects(sendMessage(db, 'A', m.id, s2.d), /already_sending/)
  const after = nonWarmup(db).find(x => x.to_email === 'b@one.example')!
  assert.deepEqual([after.status, after.attempts, after.claimed_at], ['sending', 1, due])
})

test('restart: holds survive a process restart; a crashed send reaps to uncertain and is never resent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dazl-drain-'))
  try {
    const file = join(dir, 't.sqlite')
    const db = await setup(file); ok(db); warmed(db)
    const s1 = sendStub(NOW)
    lead(db, 'a@one.example'); lead(db, 'b@one.example')
    await runAutopilot(db, 'A', 'Acme', s1.d)
    // Simulate a crashed tick: a claimed send that never reported back, plus the domain-held draft.
    const held = nonWarmup(db).find(x => x.to_email === 'b@one.example')!
    approve(db, 'A', held.id)
    db.prepare("UPDATE outreach_messages SET status = 'sending', attempts = attempts + 1, claimed_at = ? WHERE id = ?").run(NOW + 86400, held.id) // crashed long before the hold's due time
    db.close()
    // Restart: reopen the same file (migrations re-run idempotently on the existing schema).
    const db2 = new Database(file); migrateScan(db2); migrateOutreach(db2); migrateConnectors(db2); migrateAutopilot(db2)
    const due = NOW + 7 * 86400 + 1
    lead(db2, 'c@two.example') // a new eligible lead so a send is attempted and the crash is reaped
    const s2 = sendStub(due)
    await runAutopilot(db2, 'A', 'Acme', s2.d)
    const crashed = rows(db2).find(x => x.to_email === 'b@one.example')!
    assert.equal(crashed.status, 'uncertain') // reaped, never resent
    assert.equal(s2.calls.length, 0) // the uncertain outcome stops everything before any send request
    // The reap's uncertain stop lands before the approval step: the fresh candidate stays 'draft'. Both 'draft' and
    // 'approved' satisfy the #411 contract here (nothing sent, nothing lost, the uncertain row pauses everything);
    // 'draft' is the safer rest state - on resume the candidate is re-read and approved afresh, never sent off a
    // pre-crash approval. (The pre-merge hold model left it a bare lead; a visible draft is the closer bridge.)
    assert.equal(rows(db2).find(x => x.to_email === 'c@two.example')!.status, 'draft') // drafted, then held by the uncertain stop: not sent, not lost
    db2.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
