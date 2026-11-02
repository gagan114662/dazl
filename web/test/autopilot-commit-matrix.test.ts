// #448 parity matrix: the adversarial send-commitment cases of PR #448 (claude/nifty-cori-autopilot-drain @ 911fa8f9,
// 50 named cases) ported onto the evolved drain that shipped with #526/#548/#549. Disposition of every #448 case:
//   COVERED (asserted by web/test/first-touch-drain.test.ts on main):
//     #411 daily cap lift drains exactly once, no new scan | #411 per-company 7-day cap | #411 pause/resume/disable stop
//     the drain | #411 changed offer hands back | #411 warm-up drafts never auto-sent | #411 Gmail failure matrix
//     (429 backoff, reconnect, unknown never retried) | #411 two passes one claim one send
//   PORTED HERE: the mid-refresh / send-commitment adversarial matrix (this file).
//   REDESIGNED (main's evolved semantics asserted here instead of #448's): a held draft's work row gone at the
//     commitment is treated as its authority ending (disable() removes it), not "the send goes".
// Stub Gmail, synthetic leads, fixed clock, in-memory store: nothing leaves the process.
import { seedOffers } from './helpers/seed-offer.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { completeOAuth, startOAuth, GmailSendError } from '../lib/gmail/oauth.ts'
import { approve, createDraft, saveSettings, sendMessage, type Deps } from '../lib/outreach/service.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { ATTESTATIONS, CONSENT_VERSION, disable, enable, migrateAutopilot, pause, recentAutopilotAudit, resume, runAutopilot } from '../lib/outreach/autopilot.ts'
import { migrateSchedulerRuns } from '../lib/ops/scheduler-runs.ts'

const master = randomBytes(32)
const genv = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const DAY = 86400
const ON = { AUTOPILOT_ENABLED: '1', AUTOPILOT_WARMUP: '2' }
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
const tokenOk = (async (url: string) => (String(url).includes('token') ? json({ access_token: 'at' }) : json({}, 404))) as unknown as typeof fetch

async function setup() {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); seedOffers(db)
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
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)
  return id
}
const ok = (db: Database.Database) => enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 3 })
const cap1 = (db: Database.Database) => enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 1 })
// Two old warmup sends (outside every cap window), so the manual warmup gate is cleared.
const warmed = (db: Database.Database) => db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES ('s1a2b3c4d5e6f7a8b9c0d1e2','A','x1','o1@z.example','s','bodybodybodybodybodybody','sent',?,?),('s2a2b3c4d5e6f7a8b9c0d1e2','A','x2','o2@z.example','s','bodybodybodybodybodybody','sent',?,?)").run(NOW - 9e5, NOW - 9e5, NOW - 9e5, NOW - 9e5)
type SendStub = { calls: string[]; d: Deps & { flags: Record<string, string> }; fail: (e: unknown) => void; heal: () => void }
const sendStub = (now: number, firstError?: unknown): SendStub => {
  const calls: string[] = []
  let failure: unknown = firstError
  const d: Deps & { flags: Record<string, string> } = { flags: { ...ON }, env: genv, master, now, baseUrl: 'https://app.test', fetchImpl: tokenOk, sendFn: (async (_t: string, raw: string) => { calls.push(raw); if (failure) { const f = failure; failure = null; throw f } return { id: 'g' } }) as never }
  return { calls, d, fail: (e) => { failure = e }, heal: () => { failure = null } }
}
const at = (d: Deps & { flags: Record<string, string> }, now: number) => ({ ...d, now })
// Runs fn inside the token refresh (the last await before the bytes go to Gmail).
const injectAtToken = (d: Deps & { flags: Record<string, string> }, fn: () => void): Deps & { flags: Record<string, string> } => {
  const base = d.fetchImpl as unknown as (u: string, i?: unknown) => Promise<Response>
  return { ...d, fetchImpl: (async (url: string, init?: unknown) => { if (String(url).includes('token')) fn(); return base(url, init) }) as unknown as typeof fetch }
}
const work = (db: Database.Database) => db.prepare('SELECT message_id, reason, next_at, attempts FROM autopilot_work ORDER BY created_at, rowid').all() as { message_id: string; reason: string; next_at: number | null; attempts: number }[]
const msgRow = (db: Database.Database) => db.prepare("SELECT status, approved_hash, to_email FROM outreach_messages WHERE tenant_id = 'A' AND to_email NOT LIKE '%@z.example' ORDER BY created_at").all() as { status: string; approved_hash: string | null; to_email: string }[]
const audits = (db: Database.Database) => recentAutopilotAudit(db, 'A') as { action: string; detail: string | null }[]

// One pass with a daily cap of 1 over two leads: the first sends, the second is held for the window roll.
const heldAfterOneSend = async () => {
  const db = await setup(); cap1(db); warmed(db)
  const s = sendStub(NOW)
  lead(db, 'a@one.example'); lead(db, 'b@two.example')
  const r = await runAutopilot(db, 'A', 'Acme', s.d)
  assert.equal(r.sent, 1)
  assert.equal(work(db).length, 1)
  const heldTo = (db.prepare('SELECT m.to_email AS t FROM autopilot_work w JOIN outreach_messages m ON m.id = w.message_id AND m.tenant_id = w.tenant_id').get() as { t: string }).t
  return { db, s, heldTo }
}
const heldRow = (db: Database.Database, to: string) => db.prepare('SELECT status, approved_hash FROM outreach_messages WHERE to_email = ?').get(to) as { status: string; approved_hash: string | null }
const sentCount = (db: Database.Database) => (db.prepare("SELECT count(*) AS n FROM outreach_messages WHERE tenant_id = 'A' AND status = 'sent' AND to_email NOT LIKE '%@z.example'").get() as { n: number }).n
// The held draft back with the user: out of autopilot's queue, unapproved, the earlier send untouched.
const assertBackWithUser = (db: Database.Database, heldTo: string, calls: number) => {
  assert.equal(sentCount(db), 1)
  assert.equal(work(db).length, 0)
  assert.deepEqual(heldRow(db, heldTo), { status: 'draft', approved_hash: null })
}

test('#411 parity: sender identity is rechecked at send commitment - an address change during the token refresh sends nothing', async () => {
  const { db, s, heldTo } = await heldAfterOneSend()
  const d = injectAtToken(at(s.d, NOW + DAY + 1), () => db.prepare("UPDATE gmail_accounts SET email = 'swapped@other.example' WHERE tenant_id = 'A'").run())
  const r = await runAutopilot(db, 'A', 'Acme', d)
  assert.equal(r.sent, 0)
  assert.equal(s.calls.length, 1) // only the first pass's send
  assertBackWithUser(db, heldTo, s.calls.length)
  assert.ok(audits(db).some(a => a.action === 'send_failed' && a.detail === 'sender_changed'))
})

test('#411 parity: a reconnect to a different Gmail address hands the held draft back (Instinct negative)', async () => {
  const { db, s, heldTo } = await heldAfterOneSend()
  db.prepare("UPDATE gmail_accounts SET email = 'other@elsewhere.example' WHERE tenant_id = 'A'").run()
  const r = await runAutopilot(db, 'A', 'Acme', at(s.d, NOW + DAY + 1))
  assert.equal(r.sent, 0)
  assert.equal(s.calls.length, 1)
  assertBackWithUser(db, heldTo, s.calls.length)
  assert.ok(audits(db).some(a => a.action === 'released'))
})

test('#411 parity: disconnected waits; the same address reconnected sends; another address is released', async () => {
  const { db, s, heldTo } = await heldAfterOneSend()
  db.prepare("DELETE FROM gmail_accounts WHERE tenant_id = 'A'").run()
  const r1 = await runAutopilot(db, 'A', 'Acme', at(s.d, NOW + DAY + 1))
  assert.equal(r1.sent, 0)
  assert.equal(s.calls.length, 1)
  assert.equal(work(db).length, 1) // still held, waits for a reconnect
  // Reconnect the same address: the held draft sends.
  const state1 = new URL(startOAuth(db, 'A', { env: genv, now: NOW })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', state1, { env: genv, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: 'https://www.googleapis.com/auth/gmail.send', id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
  const r2 = await runAutopilot(db, 'A', 'Acme', at(s.d, NOW + DAY + 1))
  assert.equal(r2.sent, 1)
  assert.equal(s.calls.length, 2)
  // Another address: handed back, never sent.
  const h2 = await heldAfterOneSend()
  const db2 = h2.db
  db2.prepare("DELETE FROM gmail_accounts WHERE tenant_id = 'A'").run()
  const state2 = new URL(startOAuth(db2, 'A', { env: genv, now: NOW })).searchParams.get('state')!
  await completeOAuth(db2, 'A', 'c', state2, { env: genv, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: 'https://www.googleapis.com/auth/gmail.send', id_token: idToken('other@elsewhere.example') })) as unknown as typeof fetch })
  const s2 = sendStub(NOW + DAY + 1)
  const r3 = await runAutopilot(db2, 'A', 'Acme', s2.d)
  assert.equal(r3.sent, 0)
  assert.equal(s2.calls.length, 0)
  assertBackWithUser(db2, h2.heldTo, 0)
})

test('#448 parity: autopilot turned off, its operator flag off or its consent changed during the token refresh: the held draft is not sent (Instinct negative)', async () => {
  // Turned off (disable during the refresh): handed back to the user, the pass ends.
  { const { db, s, heldTo } = await heldAfterOneSend()
    const d = injectAtToken(at(s.d, NOW + DAY + 1), () => disable(db, 'A'))
    const r = await runAutopilot(db, 'A', 'Acme', d)
    assert.equal(r.sent, 0)
    assert.equal(s.calls.length, 1)
    assertBackWithUser(db, heldTo, s.calls.length)
    assert.ok(audits(db).some(a => a.action === 'released')) }
  // Operator flag off: not the tenant's decision - held (unapproved), not handed back.
  { const { db, s, heldTo } = await heldAfterOneSend()
    const d = at(s.d, NOW + DAY + 1)
    const d2 = injectAtToken(d, () => { d.flags.AUTOPILOT_ENABLED = '0' })
    const r = await runAutopilot(db, 'A', 'Acme', d2)
    assert.equal(r.sent, 0)
    assert.equal(s.calls.length, 1)
    assert.equal(work(db).length, 1) // still autopilot's: held unapproved, not handed back
    assert.deepEqual(heldRow(db, heldTo), { status: 'draft', approved_hash: null })
    assert.equal(sentCount(db), 1) }
  // Consent no longer current: handed back, never sent.
  { const { db, s, heldTo } = await heldAfterOneSend()
    const d = injectAtToken(at(s.d, NOW + DAY + 1), () => db.prepare("UPDATE autopilot_settings SET consent_version = '2000-01-01' WHERE tenant_id = 'A'").run())
    const r = await runAutopilot(db, 'A', 'Acme', d)
    assert.equal(r.sent, 0)
    assert.equal(s.calls.length, 1)
    assertBackWithUser(db, heldTo, s.calls.length) }
})

test('#448 parity: the offer, seller, sender name or postal address changed during the token refresh: the held draft is not sent (Instinct negative)', async () => {
  const changes: ((db: Database.Database) => void)[] = [
    db => saveSettings(db, 'A', { sender_name: 'Renamed', postal_address: '1 King St W, Toronto ON M5H 1A1' }),
    db => saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '9 Other Ave, Toronto ON M4B 1B2' }),
    db => db.prepare("UPDATE scan_jobs SET seller = 'Somebody Else'").run(),
  ]
  for (const change of changes) {
    const { db, s, heldTo } = await heldAfterOneSend()
    const d = injectAtToken(at(s.d, NOW + DAY + 1), () => change(db))
    const r = await runAutopilot(db, 'A', 'Acme', d)
    assert.equal(r.sent, 0)
    assert.equal(s.calls.length, 1)
    assertBackWithUser(db, heldTo, s.calls.length)
    assert.ok(audits(db).some(a => a.action === 'send_failed' && a.detail === 'authority_changed'))
  }
})

test('#448 parity: positive control - settings saved unchanged during the token refresh: the draft sends once', async () => {
  const { db, s } = await heldAfterOneSend()
  const d = injectAtToken(at(s.d, NOW + DAY + 1), () => saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' }))
  const r = await runAutopilot(db, 'A', 'Acme', d)
  assert.equal(r.sent, 1)
  assert.equal(s.calls.length, 2)
  assert.equal(work(db).length, 0)
  assert.equal(sentCount(db), 2)
})

test('#448 parity: the body, subject or recipient of the held draft changed during the token refresh: back with the user, nothing sent', async () => {
  const changes: ((db: Database.Database, to: string) => void)[] = [
    (db, to) => db.prepare("UPDATE outreach_messages SET body = 'edited words, entirely different pitch here' WHERE to_email = ?").run(to),
    (db, to) => db.prepare("UPDATE outreach_messages SET subject = 'edited subject' WHERE to_email = ?").run(to),
    (db, to) => db.prepare("UPDATE outreach_messages SET to_email = 'changed@three.example' WHERE to_email = ?").run(to),
  ]
  for (const change of changes) {
    const { db, s, heldTo } = await heldAfterOneSend()
    const d = injectAtToken(at(s.d, NOW + DAY + 1), () => change(db, heldTo))
    const r = await runAutopilot(db, 'A', 'Acme', d)
    assert.equal(r.sent, 0)
    assert.equal(s.calls.length, 1)
    assert.equal(work(db).length, 0)
    assert.equal(sentCount(db), 1)
    assert.deepEqual(heldRow(db, changes.indexOf(change) === 2 ? 'changed@three.example' : heldTo), { status: 'draft', approved_hash: null })
  }
})

test('#448 parity: autopilot turned off during the draft-polish await: the new draft is held, not sent', async () => {
  const db = await setup(); ok(db); warmed(db); migrateKeys(db); saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  lead(db, 'a@one.example')
  const s = sendStub(NOW)
  const providers = { anthropic: { complete: async () => { disable(db, 'A'); return 'not a usable draft' } } }
  const r = await runAutopilot(db, 'A', 'Acme', { ...s.d, providers } as never)
  assert.equal(r.sent, 0)
  assert.equal(s.calls.length, 0)
  assert.equal(work(db).length, 0)
  const m = msgRow(db)
  assert.equal(m[0].status, 'draft')
  assert.equal(m[0].approved_hash, null)
  assert.ok(audits(db).some(a => a.action === 'released'))
})

test('#448 parity: the offer or sender settings changed during the draft-polish await: the new draft is not sent (Instinct negative)', async () => {
  for (const change of [(db: Database.Database) => saveSettings(db, 'A', { sender_name: 'Renamed', postal_address: '1 King St W, Toronto ON M5H 1A1' }), (db: Database.Database) => db.prepare("UPDATE scan_jobs SET seller = 'Somebody Else'").run()] as ((db: Database.Database) => void)[]) {
    const db = await setup(); ok(db); warmed(db); migrateKeys(db); saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
    lead(db, 'a@one.example')
    const s = sendStub(NOW)
    const providers = { anthropic: { complete: async () => { change(db); return 'not a usable draft' } } }
    const r = await runAutopilot(db, 'A', 'Acme', { ...s.d, providers } as never)
    assert.equal(r.sent, 0)
    assert.equal(s.calls.length, 0)
    const m = msgRow(db)
    assert.equal(m[0].status, 'draft')
    assert.equal(m[0].approved_hash, null)
    assert.ok(audits(db).some(a => a.action === 'released'))
  }
})

test('#448 parity: positive control - settings saved unchanged during the polish: the draft sends once', async () => {
  const db = await setup(); ok(db); warmed(db); migrateKeys(db); saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  lead(db, 'a@one.example')
  const s = sendStub(NOW)
  const providers = { anthropic: { complete: async () => { saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' }); return 'not a usable draft' } } }
  const r = await runAutopilot(db, 'A', 'Acme', { ...s.d, providers } as never)
  assert.equal(r.sent, 1)
  assert.equal(s.calls.length, 1)
  assert.deepEqual(msgRow(db).map(m => m.status), ['sent'])
})

// A cap-2 pass over three leads: two send, one is held for the window roll (due NOW + DAY + 1, when the oldest send
// leaves the window).
const heldAfterTwoSends = async () => {
  const db = await setup()
  enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 2 })
  warmed(db)
  const s = sendStub(NOW)
  lead(db, 'a@one.example'); lead(db, 'b@two.example'); lead(db, 'c@three.example')
  const r = await runAutopilot(db, 'A', 'Acme', s.d)
  assert.equal(r.sent, 2)
  assert.equal(work(db).length, 1)
  const heldTo = (db.prepare('SELECT m.to_email AS t FROM autopilot_work w JOIN outreach_messages m ON m.id = w.message_id AND m.tenant_id = w.tenant_id').get() as { t: string }).t
  return { db, s, heldTo }
}
const workRow = (db: Database.Database) => work(db)[0]

test('#448 parity: the daily cap lowered during the token refresh: the admitted send is refused at the send commitment (Instinct negative)', async () => {
  // Another connection lowering the cap lands in the same store: this in-process write is exactly what it would do.
  const { db, s, heldTo } = await heldAfterTwoSends()
  const t = NOW + DAY + 1
  const d = injectAtToken(at(s.d, t), () => { enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 1 }); db.prepare("INSERT INTO autopilot_audit (id, tenant_id, lead_id, action, detail, created_at) VALUES ('otherprocesssend00001','A','lz','sent','z.example',?)").run(t) })
  const r = await runAutopilot(db, 'A', 'Acme', d)
  assert.equal(r.sent, 0)
  assert.equal(s.calls.length, 2)
  assert.equal(r.stopped, 'daily_cap')
  assert.deepEqual(heldRow(db, heldTo), { status: 'draft', approved_hash: null })
  assert.equal(workRow(db).reason, 'daily_cap')
  assert.ok(audits(db).some(a => a.action === 'send_failed' && a.detail === 'volume_daily_cap'))
})

test('#448 parity: positive controls - the cap saved unchanged or raised during the token refresh: the draft sends, once', async () => {
  for (const cap of [2, 3]) {
    const { db, s } = await heldAfterTwoSends()
    const d = injectAtToken(at(s.d, NOW + DAY + 1), () => enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: cap }))
    const r = await runAutopilot(db, 'A', 'Acme', d)
    assert.equal(r.sent, 1)
    assert.equal(s.calls.length, 3)
    assert.equal(work(db).length, 0)
  }
})

test('#448 parity: two passes in flight when the cap is lowered: together they send at most the new cap, nothing twice (six orderings)', async () => {
  for (let i = 0; i < 6; i++) {
    const db = await setup()
    enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 2 })
    warmed(db)
    const s = sendStub(NOW)
    lead(db, 'a@one.example'); lead(db, 'b@two.example'); lead(db, 'c@three.example')
    const r1 = await runAutopilot(db, 'A', 'Acme', s.d)
    assert.equal(r1.sent, 2)
    // A second capped pass drafts and holds another lead, so two held drafts are due at the window roll.
    lead(db, 'd@four.example')
    const r2 = await runAutopilot(db, 'A', 'Acme', s.d)
    assert.equal(r2.sent, 0)
    assert.equal(work(db).length, 2)
    // Two passes at the same start time, both held drafts claimed, both inside the token refresh; the cap drops to 1
    // there. The reservation order (random ids at the same created_at) decides which send goes; never both.
    const t = NOW + DAY + 1
    let arrived = 0
    let releaseAll: () => void = () => {}
    const both = new Promise<void>(resolve => { releaseAll = resolve })
    const barrier = (base: typeof fetch) => (async (url: string, init?: unknown) => {
      if (String(url).includes('token')) { if (++arrived === 2) { enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 1 }); releaseAll() } await both }
      return (base as unknown as (u: string, i?: unknown) => Promise<Response>)(url, init)
    }) as unknown as typeof fetch
    const dA = { ...at(s.d, t), fetchImpl: barrier(tokenOk) }
    const dB = { ...at(s.d, t), fetchImpl: barrier(tokenOk) }
    const [rA, rB] = await Promise.all([runAutopilot(db, 'A', 'Acme', dA), runAutopilot(db, 'A', 'Acme', dB)])
    assert.equal(rA.sent + rB.sent, 1, `iteration ${i}: together at most the new cap`)
    assert.equal(s.calls.length, 3)
    assert.equal(work(db).length, 1) // the loser is re-held, never double-sent
    assert.equal(sentCount(db), 3)
  }
})

test('#448 parity: the cap lowered during the draft-polish await, or during the first send: the next send is held at admission, not sent', async () => {
  // During the first send's refresh: the first send's own slot is already reserved; the next lead is held at admission.
  { const db = await setup(); cap1x(db, 2); warmed(db)
    lead(db, 'a@one.example'); lead(db, 'b@two.example')
    const s = sendStub(NOW)
    const d = injectAtToken(s.d, () => enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 1 }))
    const r = await runAutopilot(db, 'A', 'Acme', d)
    assert.equal(r.sent, 1)
    assert.equal(s.calls.length, 1)
    assert.equal(r.stopped, 'daily_cap')
    assert.equal(workRow(db).reason, 'daily_cap')
    assert.equal(sentCount(db), 1) }
  // During a polish: the cap is re-read at admission, never from the start of the pass.
  { const db = await setup(); cap1x(db, 2); warmed(db); migrateKeys(db); saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
    lead(db, 'a@one.example'); lead(db, 'b@two.example')
    const s = sendStub(NOW)
    let first = true
    const providers = { anthropic: { complete: async () => { if (first) { first = false; enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 1 }) } return 'not a usable draft' } } }
    const r = await runAutopilot(db, 'A', 'Acme', { ...s.d, providers } as never)
    assert.equal(r.sent, 1)
    assert.equal(s.calls.length, 1)
    assert.equal(workRow(db).reason, 'daily_cap') }
})
const cap1x = (db: Database.Database, cap: number) => enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: cap })

test('#448 parity: boundary - a cap this send exactly reaches sends; a cap lowered to the count already in the window (uncertain sends included) refuses it', async () => {
  // Exactly reaching: one prior autopilot send in the window, cap 2 - this send is the second and goes.
  { const db = await setup(); cap1x(db, 2); warmed(db)
    db.prepare("INSERT INTO autopilot_audit (id, tenant_id, lead_id, action, detail, created_at) VALUES ('prior1sent0000000001','A','lx','sent','x.example',?)").run(NOW - 100)
    lead(db, 'a@one.example')
    const s = sendStub(NOW)
    const r = await runAutopilot(db, 'A', 'Acme', s.d)
    assert.equal(r.sent, 1)
    assert.equal(s.calls.length, 1) }
  // Lowered to the count already in the window, an uncertain send counting: refused at the commitment.
  { const db = await setup(); cap1x(db, 3); warmed(db)
    db.prepare("INSERT INTO autopilot_audit (id, tenant_id, lead_id, action, detail, created_at) VALUES ('prior1sent0000000001','A','lx','sent','x.example',?),('prior2uncertain000001','A','ly','send_uncertain','y.example',?)").run(NOW - 100, NOW - 50)
    lead(db, 'a@one.example')
    const s = sendStub(NOW)
    const d = injectAtToken(s.d, () => enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 2 }))
    const r = await runAutopilot(db, 'A', 'Acme', d)
    assert.equal(r.sent, 0)
    assert.equal(s.calls.length, 0)
    assert.equal(workRow(db).reason, 'daily_cap')
    assert.ok(audits(db).some(a => a.action === 'send_failed' && a.detail === 'volume_daily_cap')) }
})

test('#448 parity: the user emails the same company during the token refresh: the autopilot send is refused at the commitment; another company is not', async () => {
  { const { db, s, heldTo } = await heldAfterOneSend()
    const domain = heldTo.split('@')[1]
    const d = injectAtToken(at(s.d, NOW + DAY + 1), () => db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES ('m1a2b3c4d5e6f7a8b9c0d1e2','A','x9',?,'s','bodybodybodybodybodybody','sent',?,?)").run('boss@' + domain, NOW + DAY + 1, NOW + DAY + 1))
    const r = await runAutopilot(db, 'A', 'Acme', d)
    assert.equal(r.sent, 0)
    assert.equal(s.calls.length, 1)
    assert.deepEqual(heldRow(db, heldTo), { status: 'draft', approved_hash: null })
    assert.equal(workRow(db).reason, 'domain_cap')
    assert.ok(audits(db).some(a => a.action === 'send_failed' && a.detail === 'volume_domain_cap')) }
  { const { db, s } = await heldAfterOneSend()
    const d = injectAtToken(at(s.d, NOW + DAY + 1), () => db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES ('m1a2b3c4d5e6f7a8b9c0d1e2','A','x9','boss@elsewhere.example','s','bodybodybodybodybodybody','sent',?,?)").run(NOW + DAY + 1, NOW + DAY + 1))
    const r = await runAutopilot(db, 'A', 'Acme', d)
    assert.equal(r.sent, 1)
    assert.equal(s.calls.length, 2) }
})

test('#448 parity: a cap hold at the commitment is not a try - attempts are kept; and manual sends are not autopilot volume', async () => {
  // A draft retried after a rate limit (attempts 1) refused by a cap at the commitment keeps its attempt count.
  { const db = await setup(); cap1(db); warmed(db)
    lead(db, 'a@one.example')
    const s = sendStub(NOW, new GmailSendError(429))
    const r1 = await runAutopilot(db, 'A', 'Acme', s.d)
    assert.equal(r1.sent, 0)
    s.heal()
    const w1 = workRow(db)
    assert.equal(w1.reason, 'gmail_rate_limited')
    assert.equal(w1.attempts, 1)
    // Another send lands in the window while this one is in its refresh: refused at the commitment, attempts untouched.
    const t = w1.next_at! + 1
    const d = injectAtToken(at(s.d, t), () => db.prepare("INSERT INTO autopilot_audit (id, tenant_id, lead_id, action, detail, created_at) VALUES ('otherprocesssend00001','A','lz','sent','z.example',?)").run(t))
    const r2 = await runAutopilot(db, 'A', 'Acme', d)
    assert.equal(r2.sent, 0)
    assert.equal(s.calls.length, 1) // the 429 attempt only
    assert.equal(workRow(db).attempts, 1)
    assert.equal(workRow(db).reason, 'daily_cap') }
  // A manual send is not autopilot volume: the autopilot cap only counts its own sends.
  { const db = await setup(); cap1(db); warmed(db)
    db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES ('m1a2b3c4d5e6f7a8b9c0d1e2','A','x9','boss@elsewhere.example','s','bodybodybodybodybodybody','sent',?,?)").run(NOW - 10, NOW - 10)
    lead(db, 'a@one.example')
    const s = sendStub(NOW)
    const r = await runAutopilot(db, 'A', 'Acme', s.d)
    assert.equal(r.sent, 1)
    assert.equal(s.calls.length, 1) }
})

test('#448 parity: reservations - a known-not-sent refusal releases the cap; an unknown outcome keeps counting', async () => {
  // 429 (known not sent): the reservation is released, so the next lead sends inside the same cap.
  { const db = await setup(); cap1(db); warmed(db)
    lead(db, 'a@one.example'); lead(db, 'b@two.example')
    const s = sendStub(NOW, new GmailSendError(429))
    const r = await runAutopilot(db, 'A', 'Acme', s.d)
    assert.equal(r.sent, 1) // the second lead: the released slot
    assert.equal(s.calls.length, 2)
    assert.equal(workRow(db).reason, 'gmail_rate_limited')
    assert.equal((db.prepare("SELECT count(*) AS n FROM autopilot_audit WHERE action = 'send_reserved'").get() as { n: number }).n, 0) }
  // An ambiguous outcome: the slot keeps counting; the tenant pauses; a later pass admits nothing over the cap.
  { const db = await setup(); cap1(db); warmed(db)
    lead(db, 'a@one.example')
    const s = sendStub(NOW, new Error('transport blew up'))
    const r1 = await runAutopilot(db, 'A', 'Acme', s.d)
    assert.equal(r1.sent, 0)
    assert.equal(r1.stopped, 'uncertain_send')
    s.heal()
    // The user resolves the unknown outcome (it did go out): the message is theirs to settle, the slot still counts.
    db.prepare("UPDATE outreach_messages SET status = 'sent' WHERE status = 'uncertain' AND tenant_id = 'A'").run()
    resume(db, 'A')
    lead(db, 'b@two.example')
    const s2 = sendStub(NOW + 60)
    const r2 = await runAutopilot(db, 'A', 'Acme', s2.d)
    assert.equal(r2.sent, 0)
    assert.equal(s2.calls.length, 0)
    assert.equal(workRow(db).reason, 'daily_cap') }
})

// A prepare that throws once (or always) for a matching statement: store faults inside the send commitment.
const breakPrepare = (db: Database.Database, match: string, times = 1) => {
  const orig = db.prepare.bind(db)
  let left = times
  ;(db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string, ...rest: unknown[]) => {
    if (left > 0 && sql.includes(match)) { left--; throw new Error('store fault') }
    return orig(sql, ...rest as [])
  }) as typeof db.prepare
  return () => { (db as unknown as { prepare: typeof db.prepare }).prepare = orig }
}

test('#448 parity: the volume authority cannot be read at the send commitment (the store fails once during the token refresh): refused, nothing sent, read again next pass', async () => {
  const { db, s, heldTo } = await heldAfterOneSend()
  const d = injectAtToken(at(s.d, NOW + DAY + 1), () => breakPrepare(db, 'autopilot_settings'))
  const r = await runAutopilot(db, 'A', 'Acme', d)
  assert.equal(r.sent, 0)
  assert.equal(s.calls.length, 1)
  assert.deepEqual(heldRow(db, heldTo), { status: 'draft', approved_hash: null })
  assert.equal(workRow(db).reason, 'authority_unreadable')
  // Read again next pass: the store healed, the draft sends.
  const r2 = await runAutopilot(db, 'A', 'Acme', at(s.d, NOW + DAY + 2))
  assert.equal(r2.sent, 1)
  assert.equal(s.calls.length, 2)
})

test('#448 parity: the commit mark cannot be written: no send (fail closed), the slot released, the draft held and read again next pass', async () => {
  const { db, s, heldTo } = await heldAfterOneSend()
  // The reservation row is gone when the commit mark runs (a store fault lost it): the CAS finds nothing to mark.
  const d = injectAtToken(at(s.d, NOW + DAY + 1), () => db.prepare("DELETE FROM autopilot_audit WHERE action = 'send_reserved'").run())
  const r = await runAutopilot(db, 'A', 'Acme', d)
  assert.equal(r.sent, 0)
  assert.equal(s.calls.length, 1)
  assert.deepEqual(heldRow(db, heldTo), { status: 'draft', approved_hash: null })
  assert.equal(workRow(db).reason, 'reservation_lost')
  const r2 = await runAutopilot(db, 'A', 'Acme', at(s.d, NOW + DAY + 2))
  assert.equal(r2.sent, 1)
  assert.equal(s.calls.length, 2)
})

test('#448 parity: the reservation store vanishes inside the refresh: nothing sent, the draft is NOT left approved by autopilot, the pass fails', async () => {
  const { db, s, heldTo } = await heldAfterOneSend()
  const d = injectAtToken(at(s.d, NOW + DAY + 1), () => db.prepare('DROP TABLE autopilot_audit').run())
  await assert.rejects(() => runAutopilot(db, 'A', 'Acme', d))
  assert.equal(s.calls.length, 1)
  const m = heldRow(db, heldTo)
  assert.equal(m.approved_hash, null) // never left approved by autopilot
})

test("#448 parity (redesigned): a held draft's work row gone at the commitment is its authority ended - nothing sent, back with the user", async () => {
  // #448 expected the send to go and the pass to fail on the queue. The evolved drain deliberately refuses instead:
  // the work row must still be there at the commitment, because disable() removes it (autopilot.ts deliver's commit).
  const { db, s, heldTo } = await heldAfterOneSend()
  const d = injectAtToken(at(s.d, NOW + DAY + 1), () => db.prepare("DELETE FROM autopilot_work WHERE tenant_id = 'A'").run())
  const r = await runAutopilot(db, 'A', 'Acme', d)
  assert.equal(r.sent, 0)
  assert.equal(s.calls.length, 1)
  assert.equal(r.stopped, 'autopilot_off')
  assert.deepEqual(heldRow(db, heldTo), { status: 'draft', approved_hash: null })
  assert.ok(audits(db).some(a => a.action === 'released'))
})

test('#448 parity: the store stays unreadable from the send commitment on: the pass fails, nothing is sent', async () => {
  const { db, s, heldTo } = await heldAfterOneSend()
  breakPrepare(db, 'autopilot_settings', 1_000_000) // from the commitment on, every settings read fails
  await assert.rejects(() => runAutopilot(db, 'A', 'Acme', at(s.d, NOW + DAY + 1)))
  assert.equal(s.calls.length, 1)
  assert.equal(heldRow(db, heldTo).approved_hash, null)
  // A crashed send's reap to uncertain (and never resending it) is covered by first-touch-drain's restart test.
})

test("#448 parity: the autopilot settings read fails once during the token refresh (the send path's own paused check): authority_unreadable, nothing sent, held and unapproved", async () => {
  const { db, s, heldTo } = await heldAfterOneSend()
  // The fault lands inside service.ts's own recheck (its paused read), which fails closed as authority_unreadable.
  const d = injectAtToken(at(s.d, NOW + DAY + 1), () => breakPrepare(db, 'autopilot_settings'))
  const r = await runAutopilot(db, 'A', 'Acme', d)
  assert.equal(r.sent, 0)
  assert.equal(s.calls.length, 1)
  assert.deepEqual(heldRow(db, heldTo), { status: 'draft', approved_hash: null })
  assert.equal(workRow(db).reason, 'authority_unreadable')
})

test('#448 parity: disable() hands every held first touch back: unapproved, work rows gone, one released row each; nothing sends after re-enable', async () => {
  const db = await setup(); cap1(db); warmed(db)
  const s = sendStub(NOW)
  lead(db, 'a@one.example'); lead(db, 'b@two.example')
  assert.equal((await runAutopilot(db, 'A', 'Acme', s.d)).sent, 1)
  lead(db, 'c@three.example')
  await runAutopilot(db, 'A', 'Acme', s.d) // drafts and holds the third at the cap
  assert.equal(work(db).length, 2)
  disable(db, 'A')
  assert.equal(work(db).length, 0)
  const m = msgRow(db)
  for (const r of m) if (r.status !== 'sent') assert.deepEqual([r.status, r.approved_hash], ['draft', null])
  assert.equal(audits(db).filter(a => a.action === 'released').length, 2) // one each
  enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 3 })
  const r = await runAutopilot(db, 'A', 'Acme', at(s.d, NOW + DAY + 1))
  assert.equal(r.sent, 0) // handed-back drafts are never sent on a new grant
  assert.equal(s.calls.length, 1)
})

test('#448 parity: disable() leaves warm-up holds as they are and releases only the held first touches that were due', async () => {
  const { db, s } = await heldAfterOneSend()
  // A warm-up hold (next_at NULL): the user's own already, not autopilot's to release.
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES ('w1a2b3c4d5e6f7a8b9c0d1e2','A','xw','warm@up.example','s','bodybodybodybodybodybody','draft')").run()
  db.prepare("INSERT INTO autopilot_work (message_id, tenant_id, lead_id, reason, next_at, authority, attempts, claimed_at, created_at) VALUES ('w1a2b3c4d5e6f7a8b9c0d1e2','A','xw','warmup',NULL,'x',0,NULL,?)").run(NOW)
  disable(db, 'A')
  const w = work(db)
  assert.equal(w.length, 1)
  assert.equal(w[0].reason, 'warmup') // untouched
  assert.equal(s.calls.length, 1)
})

test('#448 parity: disable() while the Gmail request is open (after the commitment): the send completes and is recorded as sent', async () => {
  const { db, s, heldTo } = await heldAfterOneSend()
  const calls: string[] = []
  const d: Deps & { flags: Record<string, string> } = { flags: { ...ON }, env: genv, master, now: NOW + DAY + 1, baseUrl: 'https://app.test', fetchImpl: tokenOk, sendFn: (async (_t: string, raw: string) => { calls.push(raw); disable(db, 'A'); return { id: 'g' } }) as never }
  const r = await runAutopilot(db, 'A', 'Acme', d)
  assert.equal(r.sent, 1) // in flight when the off landed: its own pass settles it
  assert.equal(calls.length, 1)
  assert.equal(heldRow(db, heldTo).status, 'sent')
  assert.equal(work(db).length, 0)
})

test('#448 parity: disable then re-enable during a held draft\'s token refresh: not sent under the new grant, unapproved, slot released, one released row', async () => {
  const { db, s, heldTo } = await heldAfterOneSend()
  const d = injectAtToken(at(s.d, NOW + DAY + 1), () => { disable(db, 'A'); enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 3 }) })
  const r = await runAutopilot(db, 'A', 'Acme', d)
  assert.equal(r.sent, 0)
  assert.equal(s.calls.length, 1)
  assert.deepEqual(heldRow(db, heldTo), { status: 'draft', approved_hash: null })
  assert.equal(work(db).length, 0)
  assert.equal((db.prepare("SELECT count(*) AS n FROM autopilot_audit a JOIN outreach_messages m ON m.lead_id = a.lead_id WHERE a.action = 'released' AND m.to_email = ?").get(heldTo) as { n: number }).n, 1)
})

test('#448 parity: disable() writes one autopilot progress hold row (off, nothing failing) when the scheduler table exists; and turns autopilot off even when the kind check is not widened yet', async () => {
  { const db = await setup(); ok(db); migrateSchedulerRuns(db)
    disable(db, 'A')
    const p = db.prepare("SELECT last_outcome, last_hold, consecutive_failures FROM scheduler_progress WHERE tenant_id = 'A' AND kind = 'autopilot'").get() as { last_outcome: string; last_hold: string; consecutive_failures: number }
    assert.deepEqual(p, { last_outcome: 'hold', last_hold: 'off', consecutive_failures: 0 }) }
  { const db = await setup(); ok(db)
    // A store whose kind CHECK has no 'autopilot' value yet: the row is refused, the off switch never depends on it.
    db.exec("CREATE TABLE scheduler_progress (tenant_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('scan','digest')), last_attempt_at INTEGER, last_success_at INTEGER, last_error TEXT, last_outcome TEXT, last_hold TEXT, consecutive_failures INTEGER, last_run_id TEXT, PRIMARY KEY (tenant_id, kind))")
    disable(db, 'A') // must not throw
    assert.equal((db.prepare("SELECT enabled FROM autopilot_settings WHERE tenant_id = 'A'").get() as { enabled: number }).enabled, 0) }
})

test('#448 parity: positive controls - a pause during the token refresh holds as before (then resumes); a manual send needs no autopilot', async () => {
  { const { db, s, heldTo } = await heldAfterOneSend()
    const d = injectAtToken(at(s.d, NOW + DAY + 1), () => pause(db, 'A'))
    const r = await runAutopilot(db, 'A', 'Acme', d)
    assert.equal(r.sent, 0)
    assert.equal(s.calls.length, 1)
    assert.equal(work(db).length, 1) // still autopilot's, held for the resume
    assert.deepEqual(heldRow(db, heldTo), { status: 'draft', approved_hash: null })
    assert.ok(!audits(db).some(a => a.action === 'released'))
    resume(db, 'A')
    const r2 = await runAutopilot(db, 'A', 'Acme', at(s.d, NOW + DAY + 2))
    assert.equal(r2.sent, 1) }
  { const { db, s, heldTo } = await heldAfterOneSend()
    disable(db, 'A') // autopilot entirely off: the user's own send never needs it
    const id = (db.prepare('SELECT id FROM outreach_messages WHERE to_email = ?').get(heldTo) as { id: string }).id
    approve(db, 'A', id)
    const out = await sendMessage(db, 'A', id, at(s.d, NOW + DAY + 1))
    assert.equal(out, 'sent')
    assert.equal(s.calls.length, 2) }
})

test('#448 parity: a manual send whose recheck read fails after the token refresh: refused, approved again with the reason recorded, not sent', async () => {
  const { db, s, heldTo } = await heldAfterOneSend()
  disable(db, 'A')
  const id = (db.prepare('SELECT id FROM outreach_messages WHERE to_email = ?').get(heldTo) as { id: string }).id
  approve(db, 'A', id)
  const d = injectAtToken(at(s.d, NOW + DAY + 1), () => breakPrepare(db, 'autopilot_settings'))
  await assert.rejects(() => sendMessage(db, 'A', id, d), (e: unknown) => (e as { code?: string }).code === 'authority_unreadable')
  assert.equal(s.calls.length, 1) // nothing reached Gmail
  const m = db.prepare('SELECT status, error FROM outreach_messages WHERE id = ?').get(id) as { status: string; error: string | null }
  assert.equal(m.status, 'approved') // back with the user, still approved
  assert.equal(m.error, 'authority_unreadable')
})

test('#448 parity: keep (the lease heartbeat) is awaited before every message; when it throws the pass ends there with nothing started', async () => {
  const db = await setup(); cap1x(db, 3); warmed(db)
  lead(db, 'a@one.example'); lead(db, 'b@two.example')
  const s = sendStub(NOW)
  let beats = 0
  const keep = async () => { if (++beats === 2) throw new Error('lease lost') }
  await assert.rejects(() => runAutopilot(db, 'A', 'Acme', { ...s.d, keep }))
  assert.equal(beats, 2) // awaited before each message
  assert.equal(s.calls.length, 1) // the first went; the second never started
  assert.equal(sentCount(db), 1)
})

test('#448 parity: a lead refused for a reason the user can clear is tried again an hour later; a transient store error on the next tick; a personal address never', async () => {
  // A retryable refusal (recorded an hour ago) no longer excludes the lead.
  { const db = await setup(); ok(db); warmed(db)
    const l = lead(db, 'a@one.example')
    db.prepare("INSERT INTO autopilot_audit (id, tenant_id, lead_id, action, detail, created_at) VALUES ('skippedretryable00001','A',?,'skipped','lead_ungraded',?)").run(l, NOW - 3700)
    const s = sendStub(NOW)
    const r = await runAutopilot(db, 'A', 'Acme', s.d)
    assert.equal(r.sent, 1) // retried and sent after the hour
    assert.equal(s.calls.length, 1) }
  // A transient store error on the draft path is tried again on the next tick.
  { const db = await setup(); ok(db); warmed(db)
    lead(db, 'a@one.example')
    const heal = breakPrepare(db, 'l.company, l.name, l.contact', 50) // the lead read inside createDraft
    const s1 = sendStub(NOW)
    const r1 = await runAutopilot(db, 'A', 'Acme', s1.d)
    heal()
    assert.equal(r1.sent, 0)
    assert.ok(audits(db).some(a => a.action === 'skipped' && a.detail === 'error'))
    const s2 = sendStub(NOW + 601)
    const r2 = await runAutopilot(db, 'A', 'Acme', s2.d)
    assert.equal(r2.sent, 1) // next tick: drafted and sent
    assert.equal(s2.calls.length, 1) }
  // A personal address is refused once and never retried.
  { const db = await setup(); ok(db); warmed(db)
    lead(db, 'someone@gmail.com')
    const s1 = sendStub(NOW)
    const r1 = await runAutopilot(db, 'A', 'Acme', s1.d)
    assert.equal(r1.sent, 0)
    assert.equal(r1.skipped, 1)
    const n = audits(db).filter(a => a.action === 'skipped' && a.detail === 'personal_email').length
    const s2 = sendStub(NOW + 7200)
    const r2 = await runAutopilot(db, 'A', 'Acme', s2.d)
    assert.equal(r2.sent, 0)
    assert.equal(s2.calls.length, 0)
    assert.equal(audits(db).filter(a => a.action === 'skipped' && a.detail === 'personal_email').length, n) }
})

test('#448 parity: a lead the draft path refuses is skipped once - one audit row over two passes, and the lower-scored leads behind it are reached', async () => {
  const db = await setup(); ok(db); warmed(db)
  lead(db, 'someone@gmail.com', 95) // refused: personal address
  lead(db, 'b@two.example', 80)     // behind it in score order: still reached
  const s1 = sendStub(NOW)
  const r1 = await runAutopilot(db, 'A', 'Acme', s1.d)
  assert.equal(r1.sent, 1) // the lower-scored lead was reached
  assert.equal(s1.calls.length, 1)
  const skipped = () => audits(db).filter(a => a.action === 'skipped' && a.detail === 'personal_email')
  assert.equal(skipped().length, 1)
  const s2 = sendStub(NOW + 60)
  await runAutopilot(db, 'A', 'Acme', s2.d)
  assert.equal(skipped().length, 1) // one audit row over two passes
  assert.equal(s2.calls.length, 0)
})

test('#448 parity: leads of a scan still running are not candidates (no skipped row); once the scan is done they are drafted and sent', async () => {
  const db = await setup(); ok(db); warmed(db)
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare("INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, score) VALUES ('leadrunning00000000001', ?, 'Co Run', 'a@one.example', 'Hiring roofers', 'https://n.example/a', 'Co is hiring', 90, 80)").run(job)
  db.prepare("UPDATE leads SET human_confirmed_at = 1800000000, human_confirmed_from = 'test_review' WHERE id = 'leadrunning00000000001'").run()
  const s1 = sendStub(NOW)
  const r1 = await runAutopilot(db, 'A', 'Acme', s1.d)
  assert.equal(r1.sent, 0)
  assert.equal(r1.skipped, 0) // not a refusal: simply not a candidate yet
  assert.equal(s1.calls.length, 0)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)
  const s2 = sendStub(NOW + 60)
  const r2 = await runAutopilot(db, 'A', 'Acme', s2.d)
  assert.equal(r2.sent, 1)
  assert.equal(s2.calls.length, 1)
})

test('#448 parity: leads of a budgeted scan or a trial-funded scan are never drafted by the drain; an ordinary scan\'s are', async () => {
  for (const mark of ["UPDATE scan_jobs SET run_budget = 100", "UPDATE scan_jobs SET funded_by = 'trial'"] as const) {
    const db = await setup(); ok(db); warmed(db)
    lead(db, 'a@one.example')
    db.exec(mark)
    const s = sendStub(NOW)
    const r = await runAutopilot(db, 'A', 'Acme', s.d)
    assert.equal(r.sent, 0)
    assert.equal(s.calls.length, 0)
    assert.equal(msgRow(db).length, 0) // never drafted
  }
  const db = await setup(); ok(db); warmed(db)
  lead(db, 'a@one.example')
  const s = sendStub(NOW)
  const r = await runAutopilot(db, 'A', 'Acme', s.d)
  assert.equal(r.sent, 1)
})

test('#448 parity: query plans - the skipped-row check searches autopilot_audit by lead, the disables count by action', async () => {
  const db = await setup(); ok(db)
  const plan = (sql: string) => (db.prepare('EXPLAIN QUERY PLAN ' + sql).all() as { detail: string }[]).map(r => r.detail).join(' | ')
  const skipped = plan("SELECT 1 FROM autopilot_audit WHERE tenant_id = 'A' AND lead_id = 'x' AND action = 'skipped'")
  assert.match(skipped, /SEARCH autopilot_audit USING (COVERING )?INDEX .*lead/i)
  const disables = plan("SELECT count(*) AS n FROM autopilot_audit WHERE tenant_id = 'A' AND action = 'disabled'")
  assert.match(disables, /SEARCH autopilot_audit USING (COVERING )?INDEX .*action/i)
})
