import { seedOffers } from './helpers/seed-offer.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { completeOAuth, startOAuth } from '../lib/gmail/oauth.ts'
import { approve, saveSettings, sendMessage, type Deps } from '../lib/outreach/service.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { ATTESTATIONS, CONSENT_VERSION, disable, enable, getState, pause, migrateAutopilot, recentAutopilotAudit, resume, runAutopilot } from '../lib/outreach/autopilot.ts'
import { GmailSendError } from '../lib/gmail/oauth.ts'

const master = randomBytes(32)
const genv = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
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
  // Test baseline is explicitly human-reviewed; no machine timing inference.
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE confidence IS NOT NULL AND evidence_excerpt IS NOT NULL").run()
  return id
}
const ok = (db: Database.Database) => enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 3 })
const sends = () => { const sent: string[] = []; const d: Deps & { flags: Record<string, string> } = { flags: ON, env: genv, master, now: NOW, baseUrl: 'https://app.test', fetchImpl: tokenOk, sendFn: (async (_t: string, raw: string) => { sent.push(raw); return { id: 'g' } }) as never }; return { sent, d } }


// #411: first touches autopilot could not send yet are kept (why, when next) and sent by a later pass, without a new
// scan; pause/disable stop them; changed words, sender or offer hand them back to the user; an unknown outcome is never
// retried. Stub Gmail, synthetic leads, fixed clock: nothing leaves the process.
const DAY = 86400
// Two sends the user already approved (past warm-up of 2), long ago so no cap counts them.
const pastWarmup = (db: Database.Database) => db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES ('s1a2b3c4d5e6f7a8b9c0d1e2','A','x1','o1@z.example','s','bodybodybodybodybodybody','sent',?,?),('s2a2b3c4d5e6f7a8b9c0d1e2','A','x2','o2@z.example','s','bodybodybodybodybodybody','sent',?,?)").run(NOW - 30 * DAY, NOW - 30 * DAY, NOW - 30 * DAY, NOW - 30 * DAY)
const at = (d: Deps & { flags: Record<string, string> }, now: number) => ({ ...d, now })
const work = (db: Database.Database) => db.prepare('SELECT reason, next_at, attempts FROM autopilot_work ORDER BY created_at, rowid').all() as { reason: string; next_at: number | null; attempts: number }[]
const msgs = (db: Database.Database) => db.prepare('SELECT count(*) AS n FROM outreach_messages WHERE tenant_id = ?').get('A') as { n: number }
const cap1 = (db: Database.Database) => enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 1 })

test('#411 daily cap: the held first touch is sent exactly once when the cap lifts, with no new scan', async () => {
  const db = await setup(); cap1(db); pastWarmup(db); const { sent, d } = sends()
  lead(db, 'a@one.example'); lead(db, 'b@two.example')
  const r1 = await runAutopilot(db, 'A', 'Acme', at(d, NOW))
  assert.deepEqual([r1.sent, r1.held, r1.stopped, sent.length], [1, 1, 'daily_cap', 1])
  assert.deepEqual(work(db), [{ reason: 'daily_cap', next_at: NOW + DAY + 1, attempts: 0 }], 'kept with why and when')
  const before = msgs(db).n
  assert.equal((await runAutopilot(db, 'A', 'Acme', at(d, NOW + 3600))).sent, 0, 'not due yet')
  assert.equal(sent.length, 1)
  assert.equal((await runAutopilot(db, 'A', 'Acme', at(d, NOW + DAY))).sent, 0, 'the window is inclusive at its edge')
  const r2 = await runAutopilot(db, 'A', 'Acme', at(d, NOW + DAY + 1))
  assert.deepEqual([r2.sent, sent.length, work(db).length, msgs(db).n], [1, 2, 0, before], 'sent once from the queue; no new draft')
  assert.equal((await runAutopilot(db, 'A', 'Acme', at(d, NOW + DAY + 60))).sent, 0, 'and never again')
  assert.equal(sent.length, 2)
})

test('#411 per-company cap: held for 7 days from the last send to that company, then sent', async () => {
  const db = await setup(); ok(db); pastWarmup(db); const { sent, d } = sends()
  lead(db, 'a@one.example'); lead(db, 'b@one.example')
  await runAutopilot(db, 'A', 'Acme', at(d, NOW))
  assert.equal(sent.length, 1)
  assert.deepEqual(work(db).map(w => [w.reason, w.next_at]), [['domain_cap', NOW + 7 * DAY + 1]])
  await runAutopilot(db, 'A', 'Acme', at(d, NOW + 6 * DAY)); assert.equal(sent.length, 1)
  await runAutopilot(db, 'A', 'Acme', at(d, NOW + 7 * DAY + 1)); assert.equal(sent.length, 2)
})

test('#411 pause and disable stop the queue; resume drains it', async () => {
  const db = await setup(); cap1(db); pastWarmup(db); const { sent, d } = sends()
  lead(db, 'a@one.example'); lead(db, 'b@two.example')
  await runAutopilot(db, 'A', 'Acme', at(d, NOW)); assert.equal(sent.length, 1)
  db.prepare("UPDATE autopilot_settings SET paused = 1, pause_reason = 'paused_by_user' WHERE tenant_id = 'A'").run()
  assert.equal((await runAutopilot(db, 'A', 'Acme', at(d, NOW + 2 * DAY))).stopped, 'paused'); assert.equal(sent.length, 1)
  disable(db, 'A'); resume(db, 'A')
  assert.equal((await runAutopilot(db, 'A', 'Acme', at(d, NOW + 2 * DAY))).stopped, 'off'); assert.equal(sent.length, 1)
  cap1(db)
  assert.equal((await runAutopilot(db, 'A', 'Acme', at(d, NOW + 2 * DAY))).sent, 1); assert.equal(sent.length, 2)
})

test('#411 changed words, sender identity or offer hand the held draft back to the user: never auto-sent', async () => {
  for (const change of [
    (db: Database.Database) => db.prepare("UPDATE outreach_messages SET body = body || ' edited' WHERE status = 'draft'").run(),
    (db: Database.Database) => saveSettings(db, 'A', { sender_name: 'Someone Else', postal_address: '1 King St W, Toronto ON M5H 1A1' }),
    (db: Database.Database) => db.prepare("UPDATE scan_jobs SET offer = 'A different offer' WHERE user_id = 'A'").run(),
  ]) {
    const db = await setup(); cap1(db); pastWarmup(db); const { sent, d } = sends()
    lead(db, 'a@one.example'); lead(db, 'b@two.example')
    await runAutopilot(db, 'A', 'Acme', at(d, NOW)); assert.equal(sent.length, 1)
    change(db)
    const r = await runAutopilot(db, 'A', 'Acme', at(d, NOW + DAY + 1))
    assert.deepEqual([r.sent, sent.length, work(db).length], [0, 1, 0], String(change))
    assert.ok(recentAutopilotAudit(db, 'A').some(a => a.action === 'released'))
    assert.equal((db.prepare("SELECT count(*) AS n FROM outreach_messages WHERE status = 'draft'").get() as { n: number }).n, 1, 'the draft stays for the user')
  }
})

test('#411 warm-up drafts stay the user\'s: never sent by a later pass, even once warm-up is over', async () => {
  const db = await setup(); ok(db); const { sent, d } = sends()
  lead(db, 'a@one.example'); lead(db, 'b@two.example')
  await runAutopilot(db, 'A', 'Acme', at(d, NOW))
  assert.deepEqual(work(db).map(w => [w.reason, w.next_at]), [['warmup', null], ['warmup', null]])
  pastWarmup(db)
  await runAutopilot(db, 'A', 'Acme', at(d, NOW + 30 * DAY))
  assert.equal(sent.length, 0)
})

test('#411 Gmail: a rate limit retries with backoff (known not sent); a reconnect pauses and resumes; an unknown outcome is never retried', async () => {
  // Rate limited twice, then accepted.
  { const db = await setup(); ok(db); pastWarmup(db); lead(db, 'a@one.example')
    let calls = 0; const sent: string[] = []
    const d: Deps & { flags: Record<string, string> } = { ...sends().d, sendFn: (async (_t: string, raw: string) => { if (++calls <= 2) throw new GmailSendError(429); sent.push(raw); return { id: 'g' + calls } }) as never }
    await runAutopilot(db, 'A', 'Acme', at(d, NOW))
    assert.deepEqual(work(db).map(w => [w.reason, w.next_at, w.attempts]), [['gmail_rate_limited', NOW + 3600, 1]])
    await runAutopilot(db, 'A', 'Acme', at(d, NOW + 3600))
    assert.deepEqual(work(db).map(w => [w.reason, w.next_at, w.attempts]), [['gmail_rate_limited', NOW + 3600 + 7200, 2]])
    await runAutopilot(db, 'A', 'Acme', at(d, NOW + 3600 + 7200))
    assert.deepEqual([sent.length, work(db).length], [1, 0]) }
  // Gmail needs reconnecting: autopilot pauses; the work stays due and goes once the user resumes.
  { const db = await setup(); ok(db); pastWarmup(db); lead(db, 'a@one.example')
    let fail = true; const sent: string[] = []
    const d: Deps & { flags: Record<string, string> } = { ...sends().d, sendFn: (async (_t: string, raw: string) => { if (fail) throw new GmailSendError(401); sent.push(raw); return { id: 'g1' } }) as never }
    const r = await runAutopilot(db, 'A', 'Acme', at(d, NOW))
    assert.deepEqual([r.stopped, getState(db, 'A').paused, work(db).map(w => w.reason)], ['gmail_reconnect_needed', true, ['gmail_reconnect_needed']])
    fail = false; db.prepare("UPDATE gmail_accounts SET status = 'active'").run(); resume(db, 'A')
    await runAutopilot(db, 'A', 'Acme', at(d, NOW + 60))
    assert.deepEqual([sent.length, work(db).length], [1, 0]) }
  // Network error mid-send: uncertain, autopilot pauses, and the message is never retried by autopilot.
  { const db = await setup(); ok(db); pastWarmup(db); lead(db, 'a@one.example')
    let calls = 0
    const d: Deps & { flags: Record<string, string> } = { ...sends().d, sendFn: (async () => { calls++; throw new Error('network') }) as never }
    await runAutopilot(db, 'A', 'Acme', at(d, NOW))
    assert.deepEqual([calls, work(db).length], [1, 0])
    db.prepare("UPDATE autopilot_settings SET paused = 0, pause_reason = NULL").run()
    await runAutopilot(db, 'A', 'Acme', at(d, NOW + DAY))
    assert.equal(calls, 1, 'not sent again') }
})

test('#411 two passes at once (a tick and a finishing scan): one claim, one send per held draft', async () => {
  const db = await setup(); cap1(db); pastWarmup(db)
  lead(db, 'a@one.example'); lead(db, 'b@two.example')
  const sent: string[] = []
  const slow: Deps & { flags: Record<string, string> } = { ...sends().d, sendFn: (async (_t: string, raw: string) => { await new Promise(r => setTimeout(r, 20)); sent.push(raw); return { id: 'g' + sent.length } }) as never }
  await runAutopilot(db, 'A', 'Acme', at(slow, NOW)); assert.equal(sent.length, 1)
  const later = at(slow, NOW + DAY + 1)
  const [x, y] = await Promise.all([runAutopilot(db, 'A', 'Acme', later), runAutopilot(db, 'A', 'Acme', later)])
  assert.deepEqual([x.sent + y.sent, sent.length], [1, 2])
  // A claim left by a pass that died (restart) is taken again only after it goes stale.
  lead(db, 'c@three.example')
  await runAutopilot(db, 'A', 'Acme', at(slow, NOW + 2 * DAY)) // sends c? cap 1 per 24h: b went at NOW+DAY, so c is held
  const row = db.prepare('SELECT message_id, next_at FROM autopilot_work').get() as { message_id: string; next_at: number }
  db.prepare('UPDATE autopilot_work SET claimed_at = ? WHERE message_id = ?').run(row.next_at, row.message_id) // a pass claimed it, then the process died
  await runAutopilot(db, 'A', 'Acme', at(slow, row.next_at + 60)); assert.equal(sent.length, 2, 'fresh claim: left alone')
  await runAutopilot(db, 'A', 'Acme', at(slow, row.next_at + 601)); assert.equal(sent.length, 3, 'stale claim: picked up once')
})

// Instinct's hold on 522feaa: two passes at once on DIFFERENT held drafts share one tenant's caps. The daily cap and the
// per-company 7-day rule are checked and the send reserved in one write transaction before any await, so the second pass
// sees the first's reservation. A known-not-sent refusal releases it; an unknown outcome keeps counting.
const slowSends = () => { const sent: string[] = []; const d: Deps & { flags: Record<string, string> } = { ...sends().d, sendFn: (async (_t: string, raw: string) => { await new Promise(r => setTimeout(r, 20)); sent.push(raw); return { id: 'g' + sent.length } }) as never }; return { sent, d } }
const counted = (db: Database.Database) => db.prepare("SELECT action, detail FROM autopilot_audit WHERE action IN ('sent','send_reserved','send_uncertain') ORDER BY created_at, rowid").all() as { action: string; detail: string }[]

test('#448 daily cap across two simultaneous passes on different held drafts: one send in the window (Instinct negative)', async () => {
  const db = await setup(); cap1(db); pastWarmup(db); const { sent, d } = slowSends()
  lead(db, 'a@one.example'); lead(db, 'b@two.example')
  await runAutopilot(db, 'A', 'Acme', at(d, NOW)); assert.equal(sent.length, 1)
  lead(db, 'c@three.example'); await runAutopilot(db, 'A', 'Acme', at(d, NOW))
  assert.deepEqual(work(db).map(w => [w.reason, w.next_at]), [['daily_cap', NOW + DAY + 1], ['daily_cap', NOW + DAY + 1]], 'two held drafts, same due time')
  const later = at(d, NOW + DAY + 1)
  const [x, y] = await Promise.all([runAutopilot(db, 'A', 'Acme', later), runAutopilot(db, 'A', 'Acme', later)])
  assert.deepEqual([x.sent + y.sent, sent.length], [1, 2], 'cap 1: one new send, not two')
  assert.equal(work(db).length, 1, 'the other stays held')
  assert.deepEqual(counted(db).map(c => c.action), ['sent', 'sent'], 'each send counted once; no reservation left behind')
  await runAutopilot(db, 'A', 'Acme', at(d, NOW + 2 * DAY + 2)); assert.equal(sent.length, 3, 'sent when the window moves on')
})

test('#448 per-company 7-day rule across two simultaneous passes on different drafts to the same company: one send', async () => {
  const db = await setup(); ok(db); pastWarmup(db); const { sent, d } = slowSends()
  // Two held drafts to people at the same company, both due now (e.g. held earlier by the daily cap).
  lead(db, 'ann@same.example'); lead(db, 'bob@same.example')
  const first = await Promise.all([runAutopilot(db, 'A', 'Acme', at(d, NOW)), runAutopilot(db, 'A', 'Acme', at(d, NOW))])
  assert.equal(first[0].sent + first[1].sent, 1); assert.equal(sent.length, 1, 'new leads: one per company')
  assert.deepEqual(work(db).map(w => [w.reason, w.next_at]), [['domain_cap', NOW + 7 * DAY + 1]])
  // Two held drafts for another company, due at the same moment, drained by two passes at once.
  lead(db, 'cat@other.example'); lead(db, 'dan@other.example')
  db.prepare("INSERT INTO autopilot_audit (id, tenant_id, action, detail, created_at) VALUES ('old', 'A', 'sent', 'other.example', ?)").run(NOW - 3 * DAY)
  await runAutopilot(db, 'A', 'Acme', at(d, NOW)) // both held for other.example until NOW + 4 days + 1
  assert.equal(sent.length, 1)
  const due = at(d, NOW + 4 * DAY + 1)
  const [x, y] = await Promise.all([runAutopilot(db, 'A', 'Acme', due), runAutopilot(db, 'A', 'Acme', due)])
  assert.equal(x.sent + y.sent, 1, 'one email to other.example, not two')
  assert.equal(sent.filter(r => /^To: .*@other\.example/m.test(Buffer.from(r, 'base64url').toString('utf8'))).length, 1)
})

test('#448 reservations: a known-not-sent refusal releases the cap; an unknown outcome keeps counting', async () => {
  // Rate limited (refused before sending): released, so another lead can use the cap at once.
  { const db = await setup(); cap1(db); pastWarmup(db); const sent: string[] = []; let calls = 0
    const d: Deps & { flags: Record<string, string> } = { ...sends().d, sendFn: (async (_t: string, raw: string) => { if (++calls === 1) throw new GmailSendError(429); sent.push(raw); return { id: 'g' } }) as never }
    lead(db, 'a@one.example'); lead(db, 'b@two.example')
    const r = await runAutopilot(db, 'A', 'Acme', at(d, NOW))
    assert.deepEqual([r.sent, sent.length], [1, 1], 'the refused send did not use up the daily cap')
    assert.deepEqual(counted(db).map(c => c.action), ['sent']) }
  // Network error mid-send (outcome unknown): it keeps counting, so the cap stays used.
  { const db = await setup(); ok(db); pastWarmup(db)
    const d: Deps & { flags: Record<string, string> } = { ...sends().d, sendFn: (async () => { throw new Error('network') }) as never }
    lead(db, 'a@one.example')
    await runAutopilot(db, 'A', 'Acme', at(d, NOW))
    assert.deepEqual(counted(db).map(c => [c.action, c.detail]), [['send_uncertain', 'one.example']]) }
})

// Instinct's hold on a73a6a3: the Gmail account a held draft would go out from is part of its authority. A reconnect to
// another address hands it back to the user; a disconnect waits; the same address (reconnected, or a token refresh)
// sends; a change between autopilot's check and the send itself is refused at send commitment.
const reconnect = (db: Database.Database, email: string | null) => {
  const row = db.prepare('SELECT * FROM gmail_accounts WHERE tenant_id = ?').get('A') as Record<string, unknown> | undefined
  const saved = row ?? (db as unknown as { _savedAcct?: Record<string, unknown> })._savedAcct
  ;(db as unknown as { _savedAcct?: Record<string, unknown> })._savedAcct = saved
  db.prepare('DELETE FROM gmail_accounts WHERE tenant_id = ?').run('A')
  if (email === null || !saved) return
  const r = { ...saved, email }
  db.prepare(`INSERT INTO gmail_accounts (${Object.keys(r).join(', ')}) VALUES (${Object.keys(r).map(() => '?').join(', ')})`).run(...Object.values(r) as never[])
}
const heldAfterOneSend = async () => {
  const db = await setup(); cap1(db); pastWarmup(db); const s = sends()
  lead(db, 'a@one.example'); lead(db, 'b@two.example')
  await runAutopilot(db, 'A', 'Acme', at(s.d, NOW)); assert.equal(s.sent.length, 1)
  return { db, ...s }
}
const draftsBack = (db: Database.Database) => (db.prepare("SELECT count(*) AS n FROM outreach_messages WHERE status = 'draft' AND approved_hash IS NULL").get() as { n: number }).n

test('#411 sender identity: a reconnect to a different Gmail address hands the held draft back (Instinct negative)', async () => {
  const { db, sent, d } = await heldAfterOneSend()
  db.prepare("UPDATE gmail_accounts SET email = 'different@other.example' WHERE tenant_id = 'A'").run()
  const r = await runAutopilot(db, 'A', 'Acme', at(d, NOW + DAY + 1))
  assert.deepEqual([r.sent, sent.length, work(db).length, draftsBack(db)], [0, 1, 0, 1], 'stub send called once, not twice')
  assert.ok(recentAutopilotAudit(db, 'A').some(a => a.action === 'released'))
})

test('#411 sender identity: disconnected waits; the same address reconnected or a token refresh sends; another address is released', async () => {
  { const { db, sent, d } = await heldAfterOneSend()
    reconnect(db, null) // disconnected
    await runAutopilot(db, 'A', 'Acme', at(d, NOW + DAY + 1))
    assert.deepEqual([sent.length, work(db).length], [1, 1], 'disconnected: nothing sent, the work waits')
    reconnect(db, 'me@acme.example') // the same address again
    await runAutopilot(db, 'A', 'Acme', at(d, NOW + DAY + 2))
    assert.deepEqual([sent.length, work(db).length], [2, 0], 'same address: sent once') }
  { const { db, sent, d } = await heldAfterOneSend()
    reconnect(db, null); reconnect(db, 'someone.else@other.example')
    await runAutopilot(db, 'A', 'Acme', at(d, NOW + DAY + 1))
    assert.deepEqual([sent.length, work(db).length, draftsBack(db)], [1, 0, 1], 'disconnect then another address: released') }
  { const { db, sent, d } = await heldAfterOneSend()
    db.prepare("UPDATE gmail_accounts SET refresh_ct = refresh_ct WHERE tenant_id = 'A'").run() // a token refresh: same identity
    await runAutopilot(db, 'A', 'Acme', at(d, NOW + DAY + 1))
    assert.deepEqual([sent.length, work(db).length], [2, 0], 'same address after a token refresh: sent') }
})

test('#411 sender identity is rechecked at send commitment: an address change during the token refresh sends nothing', async () => {
  const { db, sent, d } = await heldAfterOneSend()
  // The access-token request is the last await before the bytes go to Gmail: the account changes right there.
  const swap = (async (url: string, init?: unknown) => { if (String(url).includes('token')) db.prepare("UPDATE gmail_accounts SET email = 'swapped@other.example' WHERE tenant_id = 'A'").run(); return (d.fetchImpl as unknown as (u: string, i?: unknown) => Promise<Response>)(url, init) }) as unknown as typeof fetch
  const r = await runAutopilot(db, 'A', 'Acme', { ...at(d, NOW + DAY + 1), fetchImpl: swap })
  assert.deepEqual([r.sent, sent.length, work(db).length, draftsBack(db)], [0, 1, 0, 1])
  assert.ok(recentAutopilotAudit(db, 'A').some(a => a.action === 'send_failed' && a.detail === 'sender_changed'))
})

// Instinct's hold on 881ed67: autopilot's own authority (on, operator flag, current consent, its reserved slot) is
// re-read by the send path as its last check, after the token refresh, immediately before Gmail; and again after the
// draft-polish await. Ended authority: nothing sent, the slot released, the draft held and unapproved. Pause keeps its
// existing handling; a manual send never needs autopilot.
const reservations = (db: Database.Database) => (db.prepare("SELECT count(*) AS n FROM autopilot_audit WHERE action = 'send_reserved'").get() as { n: number }).n
const msgStatus = (db: Database.Database, to: string) => (db.prepare('SELECT status FROM outreach_messages WHERE to_email = ?').get(to) as { status: string }).status

test('#448 autopilot turned off, its operator flag off or its consent changed during the token refresh: the held draft is not sent (Instinct negative)', async () => {
  for (const change of ['disable', 'kill', 'consent'] as const) {
    const { db, sent, d } = await heldAfterOneSend()
    const flags = { ...d.flags }
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('token')) {
        if (change === 'disable') disable(db, 'A')
        if (change === 'kill') flags.AUTOPILOT_ENABLED = '0'
        if (change === 'consent') db.prepare("UPDATE autopilot_settings SET consent_version = 'older' WHERE tenant_id = 'A'").run()
      }
      return tokenOk(url as never)
    }) as unknown as typeof fetch
    const r = await runAutopilot(db, 'A', 'Acme', { ...at(d, NOW + DAY + 1), flags, fetchImpl })
    assert.deepEqual([r.sent, sent.length], [0, 1], `${change}: nothing more sent`)
    assert.equal(reservations(db), 0, `${change}: the reserved slot is released`)
    assert.deepEqual(work(db).map(w => w.reason), [{ disable: 'autopilot_off', kill: 'autopilot_unavailable', consent: 'consent_required' }[change]], `${change}: still held`)
    assert.equal(msgStatus(db, 'b@two.example'), 'draft', `${change}: unapproved again, nothing to send by accident`)
  }
})

test('#448 autopilot turned off during the draft-polish await: the new draft is held, not sent', async () => {
  const db = await setup(); ok(db); pastWarmup(db); migrateKeys(db); saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  const { sent, d } = sends(); lead(db, 'a@one.example')
  const providers = { anthropic: { complete: async () => { disable(db, 'A'); return 'not a usable draft' } } }
  const r = await runAutopilot(db, 'A', 'Acme', { ...at(d, NOW), providers } as never)
  assert.deepEqual([r.sent, sent.length, r.stopped], [0, 0, 'autopilot_off'])
  assert.deepEqual(work(db).map(w => w.reason), ['autopilot_off'])
  assert.equal(msgStatus(db, 'a@one.example'), 'draft')
})

test('#448 positive controls: a pause during the token refresh holds as before; re-enabled, the held draft sends once; a manual send needs no autopilot', async () => {
  { const { db, sent, d } = await heldAfterOneSend()
    const fetchImpl = (async (url: string) => { if (String(url).includes('token')) pause(db, 'A'); return tokenOk(url as never) }) as unknown as typeof fetch
    await runAutopilot(db, 'A', 'Acme', { ...at(d, NOW + DAY + 1), fetchImpl })
    assert.deepEqual([sent.length, work(db).map(w => w.reason), reservations(db)], [1, ['paused'], 0]) }
  { const { db, sent, d } = await heldAfterOneSend()
    const fetchImpl = (async (url: string) => { if (String(url).includes('token')) disable(db, 'A'); return tokenOk(url as never) }) as unknown as typeof fetch
    await runAutopilot(db, 'A', 'Acme', { ...at(d, NOW + DAY + 1), fetchImpl })
    cap1(db)
    await runAutopilot(db, 'A', 'Acme', at(d, NOW + DAY + 2))
    assert.deepEqual([sent.length, work(db).length], [2, 0], 'turned on again: the held draft goes once') }
  { const db = await setup(); const { sent, d } = sends(); lead(db, 'm@manual.example')
    disable(db, 'A')
    const id = (db.prepare('SELECT id FROM leads').get() as { id: string }).id
    const { createDraft } = await import('../lib/outreach/service.ts')
    const mid = createDraft(db, 'A', id, 'Acme'); approve(db, 'A', mid, true)
    assert.equal(await sendMessage(db, 'A', mid, at(d, NOW)), 'sent'); assert.equal(sent.length, 1) }
})

// Instinct's hold on d32bc14: the stored draft-authority fingerprint (exact words and recipient, the play's offer and
// seller, the sender name and postal address, the Gmail address, the consent version) is rechecked at the final send
// commitment, after the token refresh, and after any polishing. A mismatch: nothing sent, the reserved slot released,
// the draft unapproved and back with the user.
const duringTokenRefresh = (db: Database.Database, change: (db: Database.Database) => void) =>
  (async (url: string) => { if (String(url).includes('token')) change(db); return tokenOk(url as never) }) as unknown as typeof fetch
const AFTER_TOKEN: [string, (db: Database.Database) => void][] = [
  ['offer', db => db.prepare("UPDATE scan_jobs SET offer = 'A different offer' WHERE user_id = 'A'").run()],
  ['seller', db => db.prepare("UPDATE scan_jobs SET seller = 'Someone Else Ltd' WHERE user_id = 'A'").run()],
  ['sender name', db => saveSettings(db, 'A', { sender_name: 'Not Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })],
  ['postal address', db => saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '99 Other Rd, Ottawa ON K1A 0B1' })],
]

test('#448 the offer, seller, sender name or postal address changed during the token refresh: the held draft is not sent (Instinct negative)', async () => {
  for (const [what, change] of AFTER_TOKEN) {
    const { db, sent, d } = await heldAfterOneSend()
    const r = await runAutopilot(db, 'A', 'Acme', { ...at(d, NOW + DAY + 1), fetchImpl: duringTokenRefresh(db, change) })
    assert.deepEqual([r.sent, sent.length], [0, 1], `${what}: nothing more sent`)
    assert.equal(reservations(db), 0, `${what}: the reserved slot is released`)
    assert.deepEqual([work(db).length, draftsBack(db), msgStatus(db, 'b@two.example')], [0, 1, 'draft'], `${what}: unapproved, back with the user`)
    assert.ok(recentAutopilotAudit(db, 'A').some(a => a.action === 'send_failed' && a.detail === 'authority_changed'), `${what}: recorded why`)
  }
})

test('#448 the offer or sender settings changed during the draft-polish await: the new draft is not sent (Instinct negative)', async () => {
  for (const [what, change] of AFTER_TOKEN) {
    const db = await setup(); ok(db); pastWarmup(db); migrateKeys(db); saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
    const { sent, d } = sends(); lead(db, 'a@one.example')
    const providers = { anthropic: { complete: async () => { change(db); return 'not a usable draft' } } }
    const r = await runAutopilot(db, 'A', 'Acme', { ...at(d, NOW), providers } as never)
    assert.deepEqual([r.sent, sent.length, reservations(db)], [0, 0, 0], `${what}: nothing sent, no slot kept`)
    assert.deepEqual([work(db).length, msgStatus(db, 'a@one.example')], [0, 'draft'], `${what}: the user's to approve`)
  }
})

test('#448 positive control: settings saved unchanged during the token refresh or the polish: the draft sends once', async () => {
  const same = (db: Database.Database) => { saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' }); db.prepare("UPDATE scan_jobs SET offer = offer, seller = seller WHERE user_id = 'A'").run() }
  { const { db, sent, d } = await heldAfterOneSend()
    const r = await runAutopilot(db, 'A', 'Acme', { ...at(d, NOW + DAY + 1), fetchImpl: duringTokenRefresh(db, same) })
    assert.deepEqual([r.sent, sent.length, work(db).length, reservations(db)], [1, 2, 0, 0]) }
  { const db = await setup(); ok(db); pastWarmup(db); migrateKeys(db); saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
    const { sent, d } = sends(); lead(db, 'a@one.example')
    const providers = { anthropic: { complete: async () => { same(db); return 'not a usable draft' } } }
    const r = await runAutopilot(db, 'A', 'Acme', { ...at(d, NOW), providers } as never)
    assert.deepEqual([r.sent, sent.length], [1, 1]) }
})

// Instinct's hold on 6ffe640: volume authority. The daily cap is re-read from the store at the send commitment, after the
// token refresh, with this send's own slot left out; so is the per-company rule. A cap lowered while the request was in
// flight refuses the admitted send: nothing sent, the slot released, the draft unapproved and held until the window has
// room. An unchanged or raised cap sends exactly once. Two passes in flight together cannot exceed the lowered cap.
const onToken = (db: Database.Database, nth: number, change: (db: Database.Database) => void) => {
  let n = 0
  return (async (url: string) => { if (String(url).includes('token') && ++n === nth) change(db); return tokenOk(url as never) }) as unknown as typeof fetch
}
const setCap = (cap: number) => (db: Database.Database) => enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: cap })

test('#448 the daily cap lowered during the token refresh: the admitted send is refused at the send commitment (Instinct negative)', async () => {
  const db = await setup(); ok(db); pastWarmup(db); const { sent, d } = sends()
  lead(db, 'a@one.example'); lead(db, 'b@two.example')
  const r = await runAutopilot(db, 'A', 'Acme', { ...at(d, NOW), fetchImpl: onToken(db, 2, setCap(1)) })
  assert.deepEqual([r.sent, sent.length, getState(db, 'A').daily_cap, r.stopped], [1, 1, 1, 'daily_cap'], 'the second send is refused at the boundary')
  assert.deepEqual(counted(db).map(c => c.action), ['sent'], 'the refused slot is released; the first send counts once')
  assert.deepEqual(work(db).map(w => [w.reason, w.next_at, w.attempts]), [['daily_cap', NOW + DAY + 1, 0]], 'held until the window has room')
  assert.equal(msgStatus(db, 'b@two.example'), 'draft', 'unapproved again, nothing to send by accident')
  assert.ok(recentAutopilotAudit(db, 'A').some(a => a.action === 'send_failed' && a.detail === 'volume_daily_cap'), 'recorded why')
  await runAutopilot(db, 'A', 'Acme', at(d, NOW + DAY + 1)); assert.deepEqual([sent.length, work(db).length], [2, 0], 'sent once when the window moves on')
})

test('#448 positive controls: the cap saved unchanged or raised during the token refresh: both drafts send, each once', async () => {
  for (const [what, cap] of [['unchanged', 3], ['raised', 5]] as const) {
    const db = await setup(); ok(db); pastWarmup(db); const { sent, d } = sends()
    lead(db, 'a@one.example'); lead(db, 'b@two.example')
    const r = await runAutopilot(db, 'A', 'Acme', { ...at(d, NOW), fetchImpl: onToken(db, 2, setCap(cap)) })
    assert.deepEqual([r.sent, sent.length, work(db).length, reservations(db)], [2, 2, 0, 0], `${what}: both sent, nothing held, no slot left`)
    assert.deepEqual(counted(db).map(c => c.action), ['sent', 'sent'], `${what}: each counted once`)
  }
})

test('#448 two passes in flight when the cap is lowered: together they send at most the new cap, nothing twice', async () => {
  const db = await setup(); cap1(db); pastWarmup(db); const { sent, d } = slowSends()
  lead(db, 'a@one.example'); lead(db, 'b@two.example')
  await runAutopilot(db, 'A', 'Acme', at(d, NOW)); assert.equal(sent.length, 1)
  lead(db, 'c@three.example'); await runAutopilot(db, 'A', 'Acme', at(d, NOW))
  assert.equal(work(db).length, 2, 'two held drafts, both due tomorrow')
  // The cap is 3 when both passes reserve their send, and 1 (lowered during the second pass's token refresh, so both are
  // past admission) by the time either reaches Gmail.
  setCap(3)(db)
  const later = { ...at(d, NOW + DAY + 1), fetchImpl: onToken(db, 2, setCap(1)) }
  const [x, y] = await Promise.all([runAutopilot(db, 'A', 'Acme', later), runAutopilot(db, 'A', 'Acme', later)])
  assert.deepEqual([x.sent + y.sent, sent.length], [1, 2], 'cap 1: one send between the two passes, not two')
  assert.deepEqual(counted(db).map(c => c.action), ['sent', 'sent'], 'each send counted once; the refused slot released')
  assert.deepEqual(work(db).map(w => [w.reason, w.next_at]), [['daily_cap', NOW + 2 * DAY + 2]], 'the other is held until the window has room')
  assert.equal(draftsBack(db), 1, 'and unapproved again')
  await runAutopilot(db, 'A', 'Acme', at(d, NOW + 2 * DAY + 2)); assert.deepEqual([sent.length, work(db).length], [3, 0], 'sent once when the window moves on')
})
