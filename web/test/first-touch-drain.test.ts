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
import { ATTESTATIONS, CONSENT_VERSION, drainFirstTouch, enable, getState, migrateAutopilot, pause, resume, disable, runAutopilot } from '../lib/outreach/autopilot.ts'

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

test('daily-cap hold lifts at the due time and exactly one send occurs with no new scan', async () => {
  const db = await setup(); ok(db); warmed(db)
  const s1 = sendStub(NOW)
  for (const e of ['a@one.example', 'b@two.example', 'c@three.example', 'd@four.example']) lead(db, e)
  const r = await runAutopilot(db, 'A', 'Acme', s1.d) // cap 3: three send, the 4th drafts then holds
  assert.equal(r.sent, 3); assert.equal(r.stopped, 'daily_cap')
  const held = nonWarmup(db).find(m => m.to_email === 'd@four.example')!
  assert.equal(held.status, 'draft'); assert.equal(held.hold_reason, 'daily_cap'); assert.equal(held.hold_policy, CONSENT_VERSION)
  assert.ok(held.hold_until !== null && held.hold_until > NOW && held.hold_until <= NOW + 86400)
  // Same day: the drain sees the hold is not due; nothing goes out.
  const early = await drainFirstTouch(db, 'A', s1.d)
  assert.equal(early.sent, 0); assert.equal(s1.calls.length, 3)
  // At the due time: exactly one send, no scan, no new draft, no double-send on a second pass.
  const s2 = sendStub(NOW + 86401)
  const d1 = await drainFirstTouch(db, 'A', s2.d)
  assert.equal(d1.sent, 1); assert.equal(s2.calls.length, 1)
  assert.equal(nonWarmup(db).find(m => m.to_email === 'd@four.example')!.status, 'sent')
  const d2 = await drainFirstTouch(db, 'A', s2.d)
  assert.equal(d2.sent, 0); assert.equal(s2.calls.length, 1)
  assert.equal(nonWarmup(db).filter(m => m.status === 'sent').length, 4)
})

test('domain-cap hold lifts after seven days and the held draft then sends', async () => {
  const db = await setup(); ok(db); warmed(db)
  const s1 = sendStub(NOW)
  lead(db, 'a@one.example'); lead(db, 'b@one.example')
  const r = await runAutopilot(db, 'A', 'Acme', s1.d)
  assert.equal(r.sent, 1); assert.equal(r.held, 1)
  const held = nonWarmup(db).find(m => m.to_email === 'b@one.example')!
  assert.equal(held.hold_reason, 'held_domain_cap')
  const s2 = sendStub(NOW + 7 * 86400 + 1)
  const d = await drainFirstTouch(db, 'A', s2.d)
  assert.equal(d.sent, 1); assert.equal(s2.calls.length, 1)
})

test('warmup-manual drafts and pre-existing no-hold drafts are never auto-sent by the drain', async () => {
  const db = await setup(); ok(db) // no warmup rows: the first drafts stay manual
  const s1 = sendStub(NOW)
  lead(db, 'a@one.example')
  const r = await runAutopilot(db, 'A', 'Acme', s1.d)
  assert.equal(r.held, 1)
  assert.equal(nonWarmup(db)[0].hold_reason, 'warmup_manual')
  // A pre-existing draft with no hold record (created before the backlog existed).
  lead(db, 'b@two.example')
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES ('l1a2b3c4d5e6f7a8b9c0d1e2','A',?,'b@two.example','s','bodybodybodybodybodybody','draft')").run(nonWarmup(db)[0].id ? lead(db, 'c@three.example') : null)
  warmed(db) // clear the warmup gate: even then, neither draft is drainable
  const s2 = sendStub(NOW + 90 * 86400)
  const d = await drainFirstTouch(db, 'A', s2.d)
  assert.equal(d.sent, 0); assert.equal(s2.calls.length, 0)
  assert.deepEqual(nonWarmup(db).map(m => m.status), ['draft', 'draft'])
})

test('reconnect resumes eligible held work without a new scan', async () => {
  const db = await setup(); ok(db); warmed(db)
  const s1 = sendStub(NOW)
  lead(db, 'a@one.example'); lead(db, 'b@one.example')
  await runAutopilot(db, 'A', 'Acme', s1.d) // one sent, one domain-held
  const now2 = NOW + 7 * 86400 + 1
  const s2 = sendStub(now2, new GmailSendError(401))
  const d1 = await drainFirstTouch(db, 'A', s2.d)
  assert.equal(d1.stopped, 'gmail_reconnect_needed'); assert.equal(getState(db, 'A').paused, true)
  const m = nonWarmup(db).find(x => x.to_email === 'b@one.example')!
  assert.equal(m.status, 'approved'); assert.equal(m.hold_reason, 'held_domain_cap') // released, still held, never sent
  // User reconnects and resumes: the next drain sends the still-eligible draft.
  db.prepare("UPDATE gmail_accounts SET status = 'active' WHERE tenant_id = 'A'").run()
  resume(db, 'A')
  const s3 = sendStub(now2 + 60)
  const d2 = await drainFirstTouch(db, 'A', s3.d)
  assert.equal(d2.sent, 1); assert.equal(s3.calls.length, 1)
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
  const d = await drainFirstTouch(db, 'A', s2.d)
  assert.equal(d.sent, 0); assert.equal(d.skipped, 1); assert.equal(s2.calls.length, 0)
  const m = nonWarmup(db).find(x => x.to_email === 'b@one.example')!
  assert.equal(m.status, 'skipped'); assert.equal(m.error, 'offer_changed')
})

test('failure matrix: timeout, transport error and malformed success become uncertain, pause and are never retried', async () => {
  for (const failure of [new Error('network timeout'), new TypeError('fetch failed'), {} as unknown as Error]) {
    const db = await setup(); ok(db); warmed(db)
    const s1 = sendStub(NOW)
    lead(db, 'a@one.example'); lead(db, 'b@one.example')
    await runAutopilot(db, 'A', 'Acme', s1.d)
    const now2 = NOW + 7 * 86400 + 1
    const s2 = sendStub(now2, failure)
    const d1 = await drainFirstTouch(db, 'A', s2.d)
    assert.equal(d1.stopped, 'uncertain_send')
    assert.equal(getState(db, 'A').paused, true)
    const m = nonWarmup(db).find(x => x.to_email === 'b@one.example')!
    assert.equal(m.status, 'uncertain'); assert.equal(m.error, 'send_outcome_unknown')
    // After the user resumes, the uncertain message is still never retried.
    resume(db, 'A')
    const s3 = sendStub(now2 + 60)
    const d2 = await drainFirstTouch(db, 'A', s3.d)
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
  const d1 = await drainFirstTouch(db, 'A', s2.d)
  assert.equal(d1.sent, 0); assert.equal(d1.held, 1); assert.equal(s2.calls.length, 1)
  const m = () => nonWarmup(db).find(x => x.to_email === 'b@one.example')!
  assert.equal(m().status, 'approved'); assert.equal(m().hold_reason, 'send_failed'); assert.equal(m().attempts, 1)
  assert.ok(m().hold_until! > now2)
  const s3 = sendStub(m().hold_until! + 1)
  const d2 = await drainFirstTouch(db, 'A', s3.d)
  assert.equal(d2.sent, 1); assert.equal(s3.calls.length, 1)
  // 400: Gmail refused the message itself; never retried.
  const db2 = await setup(); ok(db2); warmed(db2)
  const t1 = sendStub(NOW)
  lead(db2, 'a@one.example'); lead(db2, 'b@one.example')
  await runAutopilot(db2, 'A', 'Acme', t1.d)
  const t2 = sendStub(NOW + 7 * 86400 + 1, new GmailSendError(400))
  const r1 = await drainFirstTouch(db2, 'A', t2.d)
  assert.equal(r1.skipped, 1)
  const m2 = () => nonWarmup(db2).find(x => x.to_email === 'b@one.example')!
  assert.equal(m2().status, 'skipped'); assert.equal(m2().error, 'gmail_rejected')
  const t3 = sendStub(NOW + 8 * 86400)
  assert.equal((await drainFirstTouch(db2, 'A', t3.d)).sent, 0); assert.equal(t3.calls.length, 0)
})

test('gmail_unavailable never reaches Gmail: no send request is made, the draft is held and later delivered', async () => {
  const db = await setup(); ok(db); warmed(db)
  const s1 = sendStub(NOW)
  lead(db, 'a@one.example'); lead(db, 'b@one.example')
  await runAutopilot(db, 'A', 'Acme', s1.d)
  const now2 = NOW + 7 * 86400 + 1
  const calls: string[] = []
  const d2h: Deps & { flags: Record<string, string> } = { flags: ON, env: genv, master, now: now2, baseUrl: 'https://app.test', fetchImpl: tokenDown, sendFn: (async (_t: string, raw: string) => { calls.push(raw); return { id: 'g' } }) as never }
  const d1 = await drainFirstTouch(db, 'A', d2h)
  assert.equal(d1.sent, 0); assert.equal(d1.held, 1)
  assert.equal(calls.length, 0) // token failure precedes any send request
  const m = nonWarmup(db).find(x => x.to_email === 'b@one.example')!
  assert.equal(m.status, 'approved'); assert.equal(m.hold_reason, 'send_failed'); assert.equal(m.hold_until! > now2, true)
  const s3 = sendStub(m.hold_until! + 1)
  const d2 = await drainFirstTouch(db, 'A', s3.d)
  assert.equal(d2.sent, 1); assert.equal(s3.calls.length, 1)
})

test('bounded retries: persistent 429 exhausts to skipped, never loops forever', async () => {
  const db = await setup(); ok(db); warmed(db)
  const s1 = sendStub(NOW)
  lead(db, 'a@one.example'); lead(db, 'b@one.example')
  await runAutopilot(db, 'A', 'Acme', s1.d)
  let now = NOW + 7 * 86400 + 1
  for (let i = 0; i < 3; i++) {
    const s = sendStub(now, new GmailSendError(429))
    const r = await drainFirstTouch(db, 'A', s.d)
    const m = nonWarmup(db).find(x => x.to_email === 'b@one.example')!
    if (i < 2) { assert.equal(r.held, 1); assert.equal(m.status, 'approved'); now = m.hold_until! + 1 }
    else { assert.equal(r.skipped, 1); assert.equal(m.status, 'skipped'); assert.equal(m.error, 'retry_exhausted') }
  }
})

test('account daily cap: re-held at the window edge without consuming retries, sent when the window rolls', async () => {
  const db = await setup(); ok(db); warmed(db)
  const s1 = sendStub(NOW)
  lead(db, 'a@one.example'); lead(db, 'b@one.example')
  await runAutopilot(db, 'A', 'Acme', s1.d)
  const now2 = NOW + 7 * 86400 + 1
  // Fill the account-level rolling window (DAILY_CAP = 20 default) at its edge.
  for (let i = 0; i < 20; i++) db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES (?, 'A', ?, ?, 's', 'bodybodybodybodybodybody', 'sent', ?, ?)").run('cap' + String(i).padStart(21, '0'), 'caplead' + i, `cap${i}@cap.example`, now2 - 3600, now2 - 3600)
  const s2 = sendStub(now2)
  for (let i = 0; i < 4; i++) { // a legitimate cap never exhausts the draft's retries
    const r = await drainFirstTouch(db, 'A', s2.d)
    assert.equal(r.sent, 0)
    const m = nonWarmup(db).find(x => x.to_email === 'b@one.example')!
    assert.equal(m.status, 'approved'); assert.equal(m.hold_reason, 'daily_cap'); assert.equal(m.attempts, i + 1) // claims count; exhaustion must not
    assert.ok(m.hold_until! > now2)
    if (i < 3) db.prepare("UPDATE outreach_messages SET hold_until = ? WHERE to_email = 'b@one.example'").run(now2) // force re-due as if the edge passed; cap still full
  }
  // Window rolls: the cap-held draft sends without any retry-exhaustion.
  const past = nonWarmup(db).find(x => x.to_email === 'b@one.example')!.hold_until! + 1
  db.prepare("UPDATE outreach_messages SET claimed_at = ?, sent_at = ? WHERE to_email LIKE 'cap%@cap.example'").run(past - 90000, past - 90000)
  const s3 = sendStub(past)
  const r = await drainFirstTouch(db, 'A', s3.d)
  assert.equal(r.sent, 1)
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
    assert.equal(rows(db2).find(x => x.to_email === 'c@two.example')!.status, 'approved') // approved pre-send, then held by the uncertain stop: not sent, not lost
    db2.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
