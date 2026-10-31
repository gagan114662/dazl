import { seedOffers } from './helpers/seed-offer.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { completeOAuth, startOAuth } from '../lib/gmail/oauth.ts'
import { approve, saveSettings, sendMessage, type Deps } from '../lib/outreach/service.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { ATTESTATIONS, CONSENT_VERSION, NEW_LEADS_SQL, disable, enable, getState, pause, migrateAutopilot, recentAutopilotAudit, resume, runAutopilot } from '../lib/outreach/autopilot.ts'
import { GmailSendError } from '../lib/gmail/oauth.ts'

const master = randomBytes(32)
const genv = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const ON = { AUTOPILOT_ENABLED: '1', AUTOPILOT_WARMUP: '2' }
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
const tokenOk = (async (url: string) => (String(url).includes('token') ? json({ access_token: 'at' }) : json({}, 404))) as unknown as typeof fetch

async function setup(file = ':memory:') {
  const db = new Database(file); migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); seedOffers(db)
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

test('#411 pause stops the queue and resume drains it; disable hands the held draft back to the user, and turning autopilot on again does not send it', async () => {
  const db = await setup(); cap1(db); pastWarmup(db); const { sent, d } = sends()
  lead(db, 'a@one.example'); lead(db, 'b@two.example')
  await runAutopilot(db, 'A', 'Acme', at(d, NOW)); assert.equal(sent.length, 1)
  db.prepare("UPDATE autopilot_settings SET paused = 1, pause_reason = 'paused_by_user' WHERE tenant_id = 'A'").run()
  assert.equal((await runAutopilot(db, 'A', 'Acme', at(d, NOW + 2 * DAY))).stopped, 'paused'); assert.equal(sent.length, 1)
  resume(db, 'A')
  assert.equal((await runAutopilot(db, 'A', 'Acme', at(d, NOW + 2 * DAY))).sent, 1); assert.equal(sent.length, 2, 'resumed: the held draft goes once')
  lead(db, 'c@three.example'); await runAutopilot(db, 'A', 'Acme', at(d, NOW + 2 * DAY)); assert.deepEqual(work(db).map(w => w.reason), ['daily_cap'])
  disable(db, 'A')
  assert.deepEqual([work(db).length, msgStatus(db, 'c@three.example'), recentAutopilotAudit(db, 'A').filter(a => a.action === 'released').length], [0, 'draft', 1], 'off: out of the queue, unapproved, recorded as released')
  assert.equal((await runAutopilot(db, 'A', 'Acme', at(d, NOW + 4 * DAY))).stopped, 'off'); assert.equal(sent.length, 2)
  cap1(db) // on again: a new grant sends nothing autopilot held under the old one
  assert.deepEqual([(await runAutopilot(db, 'A', 'Acme', at(d, NOW + 4 * DAY))).sent, sent.length, work(db).length, msgStatus(db, 'c@three.example')], [0, 2, 0, 'draft'])
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
const counted = (db: Database.Database) => db.prepare("SELECT action, detail FROM autopilot_audit WHERE action IN ('sent','send_reserved','send_committed','send_uncertain') ORDER BY created_at, rowid").all() as { action: string; detail: string }[]

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
    assert.deepEqual([r.sent, sent.length, r.stopped], [0, 1, { disable: 'autopilot_off', kill: 'autopilot_unavailable', consent: 'consent_required' }[change]], `${change}: nothing more sent`)
    assert.equal(reservations(db), 0, `${change}: the reserved slot is released`)
    if (change === 'kill') { assert.deepEqual([work(db).map(w => w.reason), msgStatus(db, 'b@two.example')], [['autopilot_unavailable'], 'draft'], 'the operator switch is not the tenant\'s decision: held, unapproved'); continue }
    assert.deepEqual([work(db).length, msgStatus(db, 'b@two.example')], [0, 'draft'], `${change}: back with the user, unapproved, out of autopilot's queue`)
    assert.equal(recentAutopilotAudit(db, 'A').filter(a => a.action === 'released').length, 1, `${change}: recorded as released, once`)
  }
})

test('#448 autopilot turned off during the draft-polish await: the new draft is held, not sent', async () => {
  const db = await setup(); ok(db); pastWarmup(db); migrateKeys(db); saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  const { sent, d } = sends(); lead(db, 'a@one.example')
  const providers = { anthropic: { complete: async () => { disable(db, 'A'); return 'not a usable draft' } } }
  const r = await runAutopilot(db, 'A', 'Acme', { ...at(d, NOW), providers } as never)
  assert.deepEqual([r.sent, sent.length, r.stopped], [0, 0, 'autopilot_off'])
  assert.deepEqual([work(db).length, msgStatus(db, 'a@one.example')], [0, 'draft'], 'the user\'s draft now')
})

test('#448 positive controls: a pause during the token refresh holds as before; re-enabled after a disable, nothing held is sent; a manual send needs no autopilot', async () => {
  { const { db, sent, d } = await heldAfterOneSend()
    const fetchImpl = (async (url: string) => { if (String(url).includes('token')) pause(db, 'A'); return tokenOk(url as never) }) as unknown as typeof fetch
    await runAutopilot(db, 'A', 'Acme', { ...at(d, NOW + DAY + 1), fetchImpl })
    assert.deepEqual([sent.length, work(db).map(w => w.reason), reservations(db)], [1, ['paused'], 0])
    assert.deepEqual([(await runAutopilot(db, 'A', 'Acme', at(d, NOW + DAY + 2))).stopped, sent.length], ['paused', 1], 'still paused: still not sent')
    resume(db, 'A'); assert.deepEqual([(await runAutopilot(db, 'A', 'Acme', at(d, NOW + DAY + 3))).sent, sent.length, work(db).length], [1, 2, 0], 'resumed: the held draft goes once') }
  { const { db, sent, d } = await heldAfterOneSend()
    const fetchImpl = (async (url: string) => { if (String(url).includes('token')) disable(db, 'A'); return tokenOk(url as never) }) as unknown as typeof fetch
    await runAutopilot(db, 'A', 'Acme', { ...at(d, NOW + DAY + 1), fetchImpl })
    cap1(db)
    await runAutopilot(db, 'A', 'Acme', at(d, NOW + DAY + 2))
    assert.deepEqual([sent.length, work(db).length, msgStatus(db, 'b@two.example')], [1, 0, 'draft'], 'turned on again: nothing held under the old grant is sent; the draft is the user\'s') }
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

// The same class, the other awaits and boundaries. The cap is read from the store when the slot is reserved (after the
// draft-polish await) and again at the commitment; a send whose bytes already left counts for the next one; the window
// counts uncertain sends; a cap this send exactly reaches sends, one lowered to the count already there refuses it; the
// per-company rule is rechecked at the commitment too; a cap lowered from another connection (another process) counts;
// a cap hold is not a try; and manual sends are not autopilot volume.
const todaySent = (db: Database.Database, id: string, action: string, at: number) => db.prepare('INSERT INTO autopilot_audit (id, tenant_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)').run(id, 'A', action, 'x.example', at)

test('#448 the cap lowered during the draft-polish await, or during the first send: the next send is held at admission, not sent', async () => {
  // Polish await (new draft): the slot is reserved after the polish, against the cap as it is then.
  { const db = await setup(); ok(db); pastWarmup(db); migrateKeys(db); saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
    const { sent, d } = sends(); lead(db, 'a@one.example'); todaySent(db, 't1', 'sent', NOW - 3600)
    const providers = { anthropic: { complete: async () => { setCap(1)(db); return 'not a usable draft' } } }
    const r = await runAutopilot(db, 'A', 'Acme', { ...at(d, NOW), providers } as never)
    assert.deepEqual([r.sent, sent.length, r.stopped, work(db).map(w => w.reason), reservations(db)], [0, 0, 'daily_cap', ['daily_cap'], 0], 'polish: held at admission') }
  // The first draft's own send (its bytes already left when the cap changed): it counts, and the second is held.
  { const db = await setup(); ok(db); pastWarmup(db); const sent: string[] = []
    const d: Deps & { flags: Record<string, string> } = { ...sends().d, sendFn: (async (_t: string, raw: string) => { sent.push(raw); setCap(1)(db); return { id: 'g' } }) as never }
    lead(db, 'a@one.example'); lead(db, 'b@two.example')
    const r = await runAutopilot(db, 'A', 'Acme', at(d, NOW))
    assert.deepEqual([r.sent, sent.length, r.stopped, work(db).map(w => w.reason)], [1, 1, 'daily_cap', ['daily_cap']], 'first send: counted; second held at admission')
    assert.ok(recentAutopilotAudit(db, 'A').some(a => a.action === 'daily_cap' && a.detail === 'cap 1'), 'the hold names the cap as it is now, not at the start of the pass') }
})

test('#448 boundary: a cap this send exactly reaches sends; a cap lowered to the count already in the window (uncertain sends included) refuses it', async () => {
  for (const [what, cap, want] of [['reaches', 3, 1], ['lowered to the count', 2, 0]] as const) {
    const db = await setup(); ok(db); pastWarmup(db); const { sent, d } = sends(); lead(db, 'a@one.example')
    todaySent(db, 't1', 'sent', NOW - 3600); todaySent(db, 't2', 'send_uncertain', NOW - 7200)
    const r = await runAutopilot(db, 'A', 'Acme', { ...at(d, NOW), fetchImpl: onToken(db, 1, setCap(cap)) })
    assert.deepEqual([r.sent, sent.length, reservations(db)], [want, want, 0], what)
    if (!want) assert.deepEqual(work(db).map(w => [w.reason, w.next_at]), [['daily_cap', NOW - 7200 + DAY + 1]], 'held until the oldest counted send leaves the window')
  }
})

test('#448 the user emails the same company during the token refresh: the autopilot send is refused at the commitment; another company is not', async () => {
  for (const [what, to, want] of [['same company', 'ceo@one.example', 0], ['another company', 'ceo@else.example', 1]] as const) {
    const db = await setup(); ok(db); pastWarmup(db); const { sent, d } = sends(); lead(db, 'a@one.example')
    const manual = (db: Database.Database) => db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES ('m1a2b3c4d5e6f7a8b9c0d1e2','A','xm',?,'s','bodybodybodybodybodybody','sent',?,?)").run(to, NOW, NOW)
    const r = await runAutopilot(db, 'A', 'Acme', { ...at(d, NOW), fetchImpl: onToken(db, 1, manual) })
    assert.deepEqual([r.sent, sent.length, reservations(db)], [want, want, 0], what)
    if (!want) {
      assert.deepEqual([work(db).map(w => [w.reason, w.next_at]), msgStatus(db, 'a@one.example')], [[['domain_cap', NOW + 7 * DAY + 1]], 'draft'], 'held 7 days from that send, unapproved')
      assert.ok(recentAutopilotAudit(db, 'A').some(a => a.action === 'send_failed' && a.detail === 'volume_domain_cap'), 'recorded why')
    }
  }
})

test('#448 another connection (another process) lowers the cap during the token refresh: refused at the commitment', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'ap-')), 'ap.db')
  const db = await setup(file); ok(db); pastWarmup(db); const { sent, d } = sends(); lead(db, 'a@one.example'); lead(db, 'b@two.example')
  const other = new Database(file)
  try {
    const r = await runAutopilot(db, 'A', 'Acme', { ...at(d, NOW), fetchImpl: onToken(db, 2, () => setCap(1)(other)) })
    assert.deepEqual([r.sent, sent.length, getState(db, 'A').daily_cap, work(db).map(w => w.reason), msgStatus(db, 'b@two.example'), reservations(db)], [1, 1, 1, ['daily_cap'], 'draft', 0])
  } finally { other.close(); db.close() }
})

test('#448 a cap hold at the commitment is not a try: a draft retried after a rate limit keeps its attempt count, and manual sends are not autopilot volume', async () => {
  { const db = await setup(); ok(db); pastWarmup(db); const sent: string[] = []; let calls = 0
    const d: Deps & { flags: Record<string, string> } = { ...sends().d, sendFn: (async (_t: string, raw: string) => { if (++calls === 1) throw new GmailSendError(429); sent.push(raw); return { id: 'g' } }) as never }
    lead(db, 'a@one.example')
    await runAutopilot(db, 'A', 'Acme', at(d, NOW))
    assert.deepEqual(work(db).map(w => [w.reason, w.attempts]), [['gmail_rate_limited', 1]])
    todaySent(db, 't1', 'sent', NOW + 3000)
    const r = await runAutopilot(db, 'A', 'Acme', { ...at(d, NOW + 3601), fetchImpl: onToken(db, 1, setCap(1)) })
    assert.deepEqual([r.sent, sent.length, work(db).map(w => [w.reason, w.attempts, w.next_at])], [0, 0, [['daily_cap', 1, NOW + 3000 + DAY + 1]]], 'held, attempts unchanged') }
  { const db = await setup(); ok(db); const { sent, d } = sends(); lead(db, 'm@manual.example')
    const id = (db.prepare('SELECT id FROM leads').get() as { id: string }).id
    const { createDraft } = await import('../lib/outreach/service.ts')
    const mid = createDraft(db, 'A', id, 'Acme'); approve(db, 'A', mid, true)
    assert.equal(await sendMessage(db, 'A', mid, { ...at(d, NOW), fetchImpl: onToken(db, 1, setCap(1)) }), 'sent'); assert.equal(sent.length, 1, 'a manual send is not refused by the autopilot cap') }
})

test('#448 the volume authority cannot be read at the send commitment (the store fails once during the token refresh): refused, nothing sent, read again next pass', async () => {
  const db = await setup(); ok(db); pastWarmup(db); const { sent, d } = sends(); lead(db, 'a@one.example')
  // One failing read of the counted sends, installed during the refresh and gone after it fired: the commitment check
  // cannot read the cap's standing, everything after it works again.
  const prepare = db.prepare.bind(db)
  const failOnce = (db2: Database.Database) => { db2.prepare = ((sql: string) => { if (sql.includes('FROM autopilot_audit a WHERE')) { delete (db2 as { prepare?: unknown }).prepare; throw new Error('disk I/O error') } return prepare(sql) }) as typeof db2.prepare }
  const r = await runAutopilot(db, 'A', 'Acme', { ...at(d, NOW), fetchImpl: onToken(db, 1, failOnce) })
  assert.deepEqual([r.sent, sent.length, r.stopped, reservations(db)], [0, 0, 'authority_unreadable', 0], 'fail closed: not sent, the slot released, the pass stopped')
  assert.deepEqual([work(db).map(w => [w.reason, w.next_at, w.attempts]), msgStatus(db, 'a@one.example')], [[['authority_unreadable', NOW, 0]], 'draft'], 'held for the next pass, unapproved')
  assert.ok(recentAutopilotAudit(db, 'A').some(a => a.action === 'send_failed' && a.detail === 'authority_unreadable'), 'recorded why')
  assert.equal(db.prepare, Database.prototype.prepare, 'the fault is gone')
  const r2 = await runAutopilot(db, 'A', 'Acme', at(d, NOW + 1)); assert.deepEqual([r2.sent, sent.length, work(db).length], [1, 1, 0], 'read again under working storage: sent once')
})

// Council on e9dff19: a hold is kept under the authority autopilot checked, not a fresh read at the time of the hold.
test('#448 the postal address changes during the Gmail request and Gmail rate-limits a new draft: the retry hands it back, not sent', async () => {
  const db = await setup(); ok(db); pastWarmup(db); const sent: string[] = []; let calls = 0
  const d: Deps & { flags: Record<string, string> } = { ...sends().d, sendFn: (async (_t: string, raw: string) => { if (++calls === 1) { saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '99 Other Rd, Ottawa ON K1A 0B1' }); throw new GmailSendError(429) } sent.push(raw); return { id: 'g' } }) as never }
  lead(db, 'a@one.example')
  const r = await runAutopilot(db, 'A', 'Acme', at(d, NOW))
  assert.deepEqual([r.sent, sent.length, work(db).map(w => [w.reason, w.attempts])], [0, 0, [['gmail_rate_limited', 1]]], 'held for the retry')
  const r2 = await runAutopilot(db, 'A', 'Acme', at(d, NOW + 3601))
  assert.deepEqual([r2.sent, sent.length, work(db).length, msgStatus(db, 'a@one.example')], [0, 0, 0, 'draft'], 'the retry sees the changed address: back with the user, never sent')
  assert.ok(recentAutopilotAudit(db, 'A').some(a => a.action === 'released'), 'recorded as released')
})

// Council on e9dff19: the drain runs every tick now. A lead the draft path refuses is skipped once, recorded once, and no
// longer holds one of the pass's 25 slots from leads autopilot can send to.
test('#448 a lead the draft path refuses is skipped once: one audit row over two passes, and the lower-scored leads behind it are reached', async () => {
  const db = await setup(); ok(db); pastWarmup(db); const { sent, d } = sends()
  for (let i = 0; i < 25; i++) lead(db, `p${i}@gmail.com`) // personal addresses: createDraft refuses every one (score 80)
  const eligible = lead(db, 'a@one.example'); db.prepare('UPDATE leads SET score = 70 WHERE id = ?').run(eligible)
  const skipped = () => db.prepare("SELECT lead_id, detail FROM autopilot_audit WHERE action = 'skipped'").all() as { lead_id: string; detail: string }[]
  const r1 = await runAutopilot(db, 'A', 'Acme', at(d, NOW))
  assert.deepEqual([r1.sent, r1.skipped, skipped().length, new Set(skipped().map(s => s.detail)).size], [0, 25, 25, 1], 'first pass: the 25 refusals fill the pass, each recorded once as personal_email')
  const r2 = await runAutopilot(db, 'A', 'Acme', at(d, NOW + 60))
  assert.deepEqual([r2.sent, r2.skipped, sent.length, skipped().length], [1, 0, 1, 25], 'second pass: no refusal retried or re-recorded; the eligible lead behind them is sent')
  const r3 = await runAutopilot(db, 'A', 'Acme', at(d, NOW + 120))
  assert.deepEqual([r3.sent, r3.skipped, skipped().length], [0, 0, 25], 'nothing left to try')
})

// Council on e9dff19: the store stays unreadable from the send commitment on. Nothing can be recorded then, so the pass
// fails as a whole (the tick records the tenant failure) and nothing is sent; the message stays in 'sending' and the slot
// keeps counting until the stale-claim sweep marks the send interrupted (uncertain), which pauses autopilot for the user.
test('#448 the store stays unreadable from the send commitment on: the pass fails, nothing is sent, the claim goes stale into uncertain and autopilot pauses', async () => {
  const db = await setup(); ok(db); pastWarmup(db); const { sent, d } = sends(); lead(db, 'a@one.example')
  const down = (db2: Database.Database) => { db2.prepare = (() => { throw new Error('disk I/O error') }) as typeof db2.prepare }
  await assert.rejects(runAutopilot(db, 'A', 'Acme', { ...at(d, NOW), fetchImpl: onToken(db, 1, down) }), /disk I\/O error/, 'the pass fails rather than deciding on an unreadable store')
  delete (db as { prepare?: unknown }).prepare; assert.equal(db.prepare, Database.prototype.prepare, 'the store is back')
  assert.deepEqual([sent.length, msgStatus(db, 'a@one.example'), reservations(db), work(db).length], [0, 'sending', 1, 0], 'not sent; the claim and the slot stand (conservative) until the sweep')
  const { reapSending } = await import('../lib/outreach/service.ts')
  reapSending(db, { now: NOW + 601 })
  assert.equal(msgStatus(db, 'a@one.example'), 'uncertain', 'the stale claim is an interrupted send: the user resolves it')
  const r = await runAutopilot(db, 'A', 'Acme', at(d, NOW + 602))
  assert.deepEqual([r.stopped, getState(db, 'A').paused, sent.length], ['uncertain_send', true, 0], 'autopilot pauses on it; nothing is retried')
})

// Reviewer 1 on e9dff19: a send past its commitment, the request to Gmail in flight, is 'send_committed' and counts at
// every other pass's commitment whatever its reservation's order ((created_at, id): the pass's start time, then a random
// id). Before: only reservations ahead in that order counted, so an in-flight send sorted behind a later-reserved one
// went uncounted and a lowered cap was exceeded.
const inFlightThenLowered = async (nowL: number, nowM: number) => {
  const db = await setup(); setCap(2)(db); pastWarmup(db); lead(db, 'a@one.example'); lead(db, 'b@two.example')
  const sent: string[] = []; const base = sends().d
  let open!: () => void; const gate = new Promise<void>(r => { open = r })
  let inFlight!: () => void; const started = new Promise<void>(r => { inFlight = r })
  // Pass L: admitted and committed at cap 2, its request to Gmail in flight (held at the gate).
  const L = runAutopilot(db, 'A', 'Acme', { ...base, now: nowL, sendFn: (async (_t: string, raw: string) => { inFlight(); await gate; sent.push(raw); return { id: 'gL' } }) as never })
  await started
  // Pass M (a finishing scan, say): admitted at cap 2 (L's slot counted: 1 < 2); the cap is lowered to 1 during its token
  // refresh. At M's commitment one send, L's, is in flight.
  const M = await runAutopilot(db, 'A', 'Acme', { ...base, now: nowM, fetchImpl: onToken(db, 1, setCap(1)), sendFn: (async (_t: string, raw: string) => { sent.push(raw); return { id: 'gM' } }) as never })
  open(); const Lr = await L
  return { db, sent, L: Lr, M }
}

test('#448 a send in flight at Gmail counts at another pass\'s commitment whatever its order: L started later (NOW+5) is in flight, M (NOW) is admitted, the cap drops 2->1 during M\'s refresh: one send', async () => {
  const { db, sent, L, M } = await inFlightThenLowered(NOW + 5, NOW)
  assert.deepEqual([L.sent, M.sent, sent.length, M.stopped], [1, 0, 1, 'daily_cap'], 'M is refused at its commitment: L\'s committed send counts though its reservation sorts behind M\'s')
  assert.deepEqual(counted(db).map(c => c.action), ['sent'], 'L\'s send counted once; M\'s slot released')
  assert.deepEqual([work(db).map(w => w.reason), msgStatus(db, 'b@two.example'), reservations(db)], [['daily_cap'], 'draft', 0], 'M\'s draft held and unapproved')
})

test('#448 the same with both passes at the same start time (the random id decides the order), six times: never two sends', async () => {
  for (let i = 0; i < 6; i++) {
    const { sent, L, M } = await inFlightThenLowered(NOW, NOW)
    assert.deepEqual([L.sent + M.sent, sent.length, M.stopped], [1, 1, 'daily_cap'], `round ${i + 1}`)
  }
})

test('#448 the commit mark cannot be written: no send (fail closed), the slot released, the draft held and read again next pass', async () => {
  const db = await setup(); ok(db); pastWarmup(db); const { sent, d } = sends(); lead(db, 'a@one.example')
  const prepare = db.prepare.bind(db)
  const failMark = (db2: Database.Database) => { db2.prepare = ((sql: string) => { if (sql.includes("SET action = 'send_committed'")) { delete (db2 as { prepare?: unknown }).prepare; throw new Error('disk I/O error') } return prepare(sql) }) as typeof db2.prepare }
  const r = await runAutopilot(db, 'A', 'Acme', { ...at(d, NOW), fetchImpl: onToken(db, 1, failMark) })
  assert.deepEqual([r.sent, sent.length, r.stopped, reservations(db), work(db).map(w => w.reason), msgStatus(db, 'a@one.example')], [0, 0, 'authority_unreadable', 0, ['authority_unreadable'], 'draft'])
  const r2 = await runAutopilot(db, 'A', 'Acme', at(d, NOW + 1)); assert.deepEqual([r2.sent, sent.length, counted(db).map(c => c.action)], [1, 1, ['sent']], 'sent once when the mark can be written')
})

// Reviewer 3 on e9dff19: disable() returns every held first touch to the user, approved ones included.
test('#448 disable() hands every held first touch back: approved ones unapproved, work rows gone, one released row each; nothing sends after re-enable', async () => {
  const { db, sent, d } = await heldAfterOneSend() // b held on the daily cap
  const b = (db.prepare("SELECT id FROM outreach_messages WHERE to_email = 'b@two.example'").get() as { id: string }).id
  approve(db, 'A', b) // the user approved it meanwhile: still autopilot's to send when the cap lifts, until autopilot is turned off
  assert.deepEqual([work(db).length, msgStatus(db, 'b@two.example')], [1, 'approved'])
  disable(db, 'A')
  const released = recentAutopilotAudit(db, 'A').filter(a => a.action === 'released')
  assert.deepEqual([work(db).length, msgStatus(db, 'b@two.example'), released.length, released[0]?.message_id], [0, 'draft', 1, b], 'unapproved, out of the queue, recorded')
  assert.equal((db.prepare('SELECT approved_hash FROM outreach_messages WHERE id = ?').get(b) as { approved_hash: string | null }).approved_hash, null)
  cap1(db)
  assert.deepEqual([(await runAutopilot(db, 'A', 'Acme', at(d, NOW + DAY + 1))).sent, sent.length], [0, 1], 'on again: not sent')
})

// Reviewer 3 on e9dff19: a read that fails inside the send path's own rechecks (before authorize) is the same refusal.
test('#448 the autopilot settings read fails once during the token refresh (the send path\'s own paused check): authority_unreadable, nothing sent, held and unapproved', async () => {
  const db = await setup(); ok(db); pastWarmup(db); const { sent, d } = sends(); lead(db, 'a@one.example')
  const prepare = db.prepare.bind(db)
  const failOnce = (db2: Database.Database) => { db2.prepare = ((sql: string) => { if (sql.includes('FROM autopilot_settings')) { delete (db2 as { prepare?: unknown }).prepare; throw new Error('disk I/O error') } return prepare(sql) }) as typeof db2.prepare }
  const r = await runAutopilot(db, 'A', 'Acme', { ...at(d, NOW), fetchImpl: onToken(db, 1, failOnce) })
  assert.deepEqual([r.sent, sent.length, r.stopped, reservations(db), work(db).map(w => [w.reason, w.next_at]), msgStatus(db, 'a@one.example')], [0, 0, 'authority_unreadable', 0, [['authority_unreadable', NOW]], 'draft'])
  assert.ok(recentAutopilotAudit(db, 'A').some(a => a.action === 'send_failed' && a.detail === 'authority_unreadable'), 'recorded why')
  const r2 = await runAutopilot(db, 'A', 'Acme', at(d, NOW + 1)); assert.deepEqual([r2.sent, sent.length], [1, 1], 'read again: sent once')
})

// Reviewer 3 on e9dff19: the words and the recipient are covered by the send path's own changed-since-approval check.
test('#448 the body, subject or recipient of the held draft changed during the token refresh: changed_since_approval, nothing sent, back with the user', async () => {
  for (const [what, sql] of [['body', "UPDATE outreach_messages SET body = body || ' PS: one more thing' WHERE to_email = 'b@two.example'"], ['subject', "UPDATE outreach_messages SET subject = 'Other subject' WHERE to_email = 'b@two.example'"], ['recipient', "UPDATE outreach_messages SET to_email = 'c@two.example' WHERE to_email = 'b@two.example'"]] as const) {
    const { db, sent, d } = await heldAfterOneSend()
    const r = await runAutopilot(db, 'A', 'Acme', { ...at(d, NOW + DAY + 1), fetchImpl: duringTokenRefresh(db, db2 => { db2.prepare(sql).run() }) })
    const to = what === 'recipient' ? 'c@two.example' : 'b@two.example'
    assert.deepEqual([r.sent, sent.length, reservations(db), work(db).length, draftsBack(db), msgStatus(db, to)], [0, 1, 0, 0, 1, 'draft'], `${what}: not sent, slot released, the user\'s again`)
    assert.ok(recentAutopilotAudit(db, 'A').some(a => a.action === 'send_failed' && a.detail === 'changed_since_approval'), `${what}: recorded why`)
  }
})

// Adversarial probe on e9dff19 (F2, F3): a store write that fails while the outcome is being recorded. The draft is dealt
// with first and every record written on its own, so what is true of the message (not sent / sent) is what the store
// says; the pass still fails afterwards (the tick records the tenant failure).
test('#448 the reservation store vanishes inside the refresh: nothing sent, the draft is NOT left approved by autopilot, the pass fails', async () => {
  const db = await setup(); setCap(5)(db); pastWarmup(db); const { sent, d } = sends(); lead(db, 'a@one.example')
  await assert.rejects(runAutopilot(db, 'A', 'Acme', { ...at(d, NOW), fetchImpl: onToken(db, 1, db2 => db2.exec('DROP TABLE autopilot_audit')) }), /no such table: autopilot_audit/)
  const m = db.prepare("SELECT status, approved_hash FROM outreach_messages WHERE to_email = 'a@one.example'").get() as { status: string; approved_hash: string | null }
  assert.deepEqual([sent.length, m.status, m.approved_hash], [0, 'draft', null], 'known not sent, and the user does not find autopilot\'s approval on it')
})

test('#448 the queue table vanishes inside the refresh: the send goes (authority intact) and is recorded as sent, once; the pass fails on the queue', async () => {
  const db = await setup(); setCap(5)(db); pastWarmup(db); const { sent, d } = sends(); lead(db, 'a@one.example')
  await assert.rejects(runAutopilot(db, 'A', 'Acme', { ...at(d, NOW), fetchImpl: onToken(db, 1, db2 => db2.exec('DROP TABLE autopilot_work')) }), /no such table: autopilot_work/)
  assert.deepEqual([sent.length, msgStatus(db, 'a@one.example'), counted(db).map(c => c.action), getState(db, 'A').paused], [1, 'sent', ['sent'], false], 'a real send is a send in the record too, not an unknown outcome')
})

// Adversarial probe (F2, the realistic trigger): the scheduler's lease is kept alive between a tenant's messages.
test('#448 keep (the lease heartbeat) is awaited before every message; when it throws the pass ends there with nothing started', async () => {
  const db = await setup(); ok(db); pastWarmup(db); const { sent, d } = sends(); lead(db, 'a@one.example'); lead(db, 'b@two.example')
  let kept = 0
  await runAutopilot(db, 'A', 'Acme', { ...at(d, NOW), keep: async () => { kept++ } })
  assert.deepEqual([sent.length, kept], [2, 2], 'once per message')
  const db2 = await setup(); ok(db2); pastWarmup(db2); const two = sends(); lead(db2, 'a@one.example'); lead(db2, 'b@two.example')
  let n = 0
  await assert.rejects(runAutopilot(db2, 'A', 'Acme', { ...at(two.d, NOW), keep: async () => { if (++n === 2) throw new Error('lease lost') } }), /lease lost/)
  assert.deepEqual([two.sent.length, reservations(db2), (db2.prepare('SELECT count(*) AS n FROM outreach_messages WHERE tenant_id = ? AND sent_at IS NULL').get('A') as { n: number }).n], [1, 0, 0], 'the first went and is settled; the second was never drafted')
})

// Round 2 (all seats + probe): a refusal of the draft path that can change is tried again (an hour later, or at once when
// the user confirmed the lead after it; a store error on the next tick); one that never changes is final. The
// exclusion is by the skipped audit row: its reason and its age.
test('#448 a lead refused for a reason the user can clear is tried again an hour later; a transient store error on the next tick; a personal address never', async () => {
  const db = await setup(); ok(db); pastWarmup(db); const { sent, d } = sends()
  lead(db, 'p@gmail.com') // (lead() re-stamps every lead's confirmation: create it first)
  const fixable = lead(db, 'a@one.example'); db.prepare('UPDATE leads SET fit = 0, intent = NULL, human_confirmed_at = ? WHERE id = ?').run(NOW - 1, fixable) // ungraded (confirmed earlier): the user grades it later
  const skipped = () => (db.prepare("SELECT lead_id, detail FROM autopilot_audit WHERE action = 'skipped' ORDER BY created_at, rowid").all() as { lead_id: string; detail: string }[]).map(s => s.detail)
  const r1 = await runAutopilot(db, 'A', 'Acme', at(d, NOW))
  assert.deepEqual([r1.sent, skipped().sort()], [0, ['lead_ungraded', 'personal_email']], 'both refused once')
  db.prepare('UPDATE leads SET fit = 1, intent = 4 WHERE id = ?').run(fixable) // graded
  const r2 = await runAutopilot(db, 'A', 'Acme', at(d, NOW + 120))
  assert.deepEqual([r2.sent, r2.skipped, skipped().length], [0, 0, 2], 'within the hour: neither retried, nothing re-recorded')
  const r3 = await runAutopilot(db, 'A', 'Acme', at(d, NOW + 3601))
  assert.deepEqual([r3.sent, sent.length, r3.skipped, skipped().length], [1, 1, 0, 2], 'an hour on: the graded lead is drafted and sent; the personal address is not retried')
  await runAutopilot(db, 'A', 'Acme', at(d, NOW + 2 * DAY)); assert.equal(skipped().length, 2, 'the personal address: never again')
  // Still refused an hour later, and the hour after: the same skipped row moves, no new one (the audit view is not buried).
  const db4 = await setup(); ok(db4); pastWarmup(db4); const four = sends(); const still = lead(db4, 'u@ungraded.example'); db4.prepare('UPDATE leads SET fit = 0, intent = NULL, human_confirmed_at = ? WHERE id = ?').run(NOW - 1, still)
  for (const t of [NOW, NOW + 3601, NOW + 7202]) await runAutopilot(db4, 'A', 'Acme', at(four.d, t))
  assert.deepEqual(db4.prepare("SELECT detail, created_at FROM autopilot_audit WHERE action = 'skipped'").all(), [{ detail: 'lead_ungraded', created_at: NOW + 7202 }], 'one row, its time the last refusal')
  assert.equal(four.sent.length, 0)
  // A transient error while drafting (one failing insert): recorded as skipped:error, retried a day later, sent then.
  const db2 = await setup(); ok(db2); pastWarmup(db2); const two = sends(); lead(db2, 'b@two.example')
  const prepare = db2.prepare.bind(db2)
  db2.prepare = ((sql: string) => { if (sql.includes('INSERT INTO outreach_messages')) { delete (db2 as { prepare?: unknown }).prepare; throw new Error('SQLITE_BUSY: database is locked') } return prepare(sql) }) as typeof db2.prepare
  const e1 = await runAutopilot(db2, 'A', 'Acme', at(two.d, NOW))
  assert.deepEqual([e1.sent, e1.skipped, (db2.prepare("SELECT detail FROM autopilot_audit WHERE action = 'skipped'").all() as { detail: string }[]).map(x => x.detail)], [0, 1, ['error']])
  assert.deepEqual([(await runAutopilot(db2, 'A', 'Acme', at(two.d, NOW + 60))).sent, (await runAutopilot(db2, 'A', 'Acme', at(two.d, NOW + 601))).sent, two.sent.length], [0, 1, 1], 'not hammered; tried again on the next tick')
  // Probe r2: a verified lead not yet confirmed by the user is refused (lead_currentness_unconfirmed); confirmed later, it
  // is drafted on the very next pass.
  const db3 = await setup(); ok(db3); pastWarmup(db3); const three = sends(); const unc = lead(db3, 'c@three.example')
  db3.prepare('UPDATE leads SET human_confirmed_at = NULL, human_confirmed_from = NULL WHERE id = ?').run(unc)
  const u1 = await runAutopilot(db3, 'A', 'Acme', at(three.d, NOW))
  assert.deepEqual([u1.sent, u1.skipped, (db3.prepare("SELECT detail FROM autopilot_audit WHERE action = 'skipped'").all() as { detail: string }[]).map(x => x.detail)], [0, 1, ['lead_currentness_unconfirmed']])
  db3.prepare("UPDATE leads SET human_confirmed_at = ?, human_confirmed_from = 'user_review' WHERE id = ?").run(NOW + 60, unc)
  assert.deepEqual([(await runAutopilot(db3, 'A', 'Acme', at(three.d, NOW + 120))).sent, three.sent.length], [1, 1], 'confirmed after the refusal: drafted and sent on the next pass')
})

// Reviewer 1 round 2: disable() and enable() again DURING a held draft's token refresh. The pass's commitment requires
// the grant it started under (no disable since) and, for a held draft, its work row: both gone, so nothing is sent and
// the draft is the user's, released once.
test('#448 disable then re-enable during a held draft\'s token refresh: not sent under the new grant, draft unapproved, slot released, one released row', async () => {
  const { db, sent, d } = await heldAfterOneSend()
  const fetchImpl = (async (url: string) => { if (String(url).includes('token')) { disable(db, 'A'); cap1(db) } return tokenOk(url as never) }) as unknown as typeof fetch
  const r = await runAutopilot(db, 'A', 'Acme', { ...at(d, NOW + DAY + 1), fetchImpl })
  const b = db.prepare("SELECT status, approved_hash FROM outreach_messages WHERE to_email = 'b@two.example'").get() as { status: string; approved_hash: string | null }
  assert.deepEqual([r.sent, sent.length, r.stopped, reservations(db), work(db).length, b.status, b.approved_hash], [0, 1, 'autopilot_off', 0, 0, 'draft', null])
  assert.equal(recentAutopilotAudit(db, 'A').filter(a => a.action === 'released').length, 1, 'released once, not twice')
  assert.deepEqual([(await runAutopilot(db, 'A', 'Acme', at(d, NOW + DAY + 2))).sent, sent.length], [0, 1], 'the new grant sends nothing autopilot held')
  // A new draft (no work row) in the same situation: the grant check alone refuses it.
  const db2 = await setup(); ok(db2); pastWarmup(db2); const two = sends(); lead(db2, 'c@three.example')
  const r2 = await runAutopilot(db2, 'A', 'Acme', { ...at(two.d, NOW), fetchImpl: onToken(db2, 1, db3 => { disable(db3, 'A'); setCap(3)(db3) }) })
  assert.deepEqual([r2.sent, two.sent.length, r2.stopped, msgStatus(db2, 'c@three.example'), work(db2).length], [0, 0, 'autopilot_off', 'draft', 0])
})

// Reviewer 1 round 2 (R1-6): disable() landing after the commitment, the Gmail request in flight: that send completes
// and is recorded as sent; no "released" row is written for it.
test('#448 disable() while the Gmail request is open (after the commitment): the held draft stays sending and unreleased until the send completes, then recorded as sent', async () => {
  const { db, sent, d } = await heldAfterOneSend() // b held on the daily cap: a queued (held) draft, due the next day
  const released = () => recentAutopilotAudit(db, 'A').filter(a => a.action === 'released').length
  let during: unknown[] = []
  const sendFn = (async (_t: string, raw: string) => {
    disable(db, 'A') // lands with the request open
    during = [msgStatus(db, 'b@two.example'), released(), work(db).map(w => w.reason), counted(db).map(c => c.action), getState(db, 'A').enabled]
    sent.push(raw); return { id: 'g' }
  }) as never
  const r = await runAutopilot(db, 'A', 'Acme', { ...at(d, NOW + DAY + 1), sendFn })
  assert.deepEqual(during, ['sending', 0, ['daily_cap'], ['sent', 'send_committed'], false], 'with the request open: still sending, its work row kept, nothing "released", the slot committed')
  assert.deepEqual([r.sent, sent.length, msgStatus(db, 'b@two.example'), counted(db).map(c => c.action), work(db).length, released()], [1, 2, 'sent', ['sent', 'sent'], 0, 0], 'completed: recorded as sent, no released row')
})

// Reviewer 2 round 2 (R2-7): disable() leaves warm-up holds alone (the user's already) and releases only the due ones.
test('#448 disable() leaves warm-up holds as they are and releases only the held first touches that were due', async () => {
  const db = await setup(); cap1(db); const { sent, d } = sends() // warm-up of 2 not reached: the first draft is a warm-up hold
  lead(db, 'w@warm.example')
  await runAutopilot(db, 'A', 'Acme', at(d, NOW))
  assert.deepEqual(work(db).map(w => [w.reason, w.next_at]), [['warmup', null]])
  disable(db, 'A')
  assert.deepEqual([work(db).map(w => w.reason), recentAutopilotAudit(db, 'A').filter(a => a.action === 'released').length, sent.length], [['warmup'], 0, 0], 'untouched, nothing "released"')
})

// Reviewer 2 round 2 (R2-8): a manual send whose post-refresh recheck read fails is refused (authority_unreadable), the
// message back in approved with that reason recorded; nothing sent.
test('#448 a manual send whose recheck read fails after the token refresh: refused, approved again with the reason recorded, not sent', async () => {
  const db = await setup(); const { sent, d } = sends(); lead(db, 'm@manual.example')
  const id = (db.prepare('SELECT id FROM leads').get() as { id: string }).id
  const { createDraft } = await import('../lib/outreach/service.ts')
  const mid = createDraft(db, 'A', id, 'Acme'); approve(db, 'A', mid, true)
  await assert.rejects(sendMessage(db, 'A', mid, { ...at(d, NOW), fetchImpl: onToken(db, 1, db2 => db2.exec('DROP TABLE suppressions')) }), (e: unknown) => (e as { code?: string }).code === 'authority_unreadable')
  assert.deepEqual([sent.length, db.prepare('SELECT status, error FROM outreach_messages WHERE id = ?').get(mid)], [0, { status: 'approved', error: 'authority_unreadable' }])
})

// Reviewer 1 round 3 (R8): the new-lead query's skipped-row check and the commitment's disables read are index searches
// by lead / by action, never a scan of the tenant's audit (never pruned; 200k rows scanned per candidate lead = minutes,
// synchronously, on every tick).
test('#448 query plans: the skipped-row check searches autopilot_audit by lead, the disables count by action', async () => {
  const db = await setup()
  const plan = (sql: string, ...params: unknown[]) => (db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params) as { detail: string }[]).map(r => r.detail)
  const leads = plan(NEW_LEADS_SQL, 'A', 80, 'A', 'A', NOW - 600, NOW - 3600)
  assert.ok(leads.some(d => /SEARCH a USING (COVERING )?INDEX autopilot_audit_lead \(tenant_id=\? AND lead_id=\? AND action=\?\)/.test(d)), leads.join('\n'))
  const disables = plan("SELECT count(*) AS n FROM autopilot_audit WHERE tenant_id = ? AND action = 'disabled'", 'A')
  assert.ok(disables.some(d => /USING (COVERING )?INDEX autopilot_audit_action \(tenant_id=\? AND action=\?\)/.test(d)), disables.join('\n'))
})

// Reviewer 1 round 3 (R10): the tenant turning autopilot off is a hold in the scheduler's view, not a frozen failure.
test('#448 disable() writes one autopilot progress hold row (off, nothing failing) when the scheduler table exists', async () => {
  const db = await setup(); ok(db)
  const { migrateSchedulerRuns } = await import('../lib/ops/scheduler-runs.ts'); migrateSchedulerRuns(db)
  db.prepare("INSERT INTO scheduler_progress (tenant_id, kind, last_attempt_at, last_error, last_outcome, consecutive_failures, last_run_id) VALUES ('A', 'autopilot', ?, 'SqliteError: no such table', 'failure', 3, 'r1')").run(NOW)
  disable(db, 'A')
  const row = db.prepare("SELECT last_outcome, last_hold, consecutive_failures, last_error FROM scheduler_progress WHERE tenant_id = 'A' AND kind = 'autopilot'").get()
  assert.deepEqual(row, { last_outcome: 'hold', last_hold: 'off', consecutive_failures: 0, last_error: null })
  assert.equal(db.prepare("SELECT count(*) AS n FROM scheduler_progress WHERE tenant_id = 'A'").pluck().get(), 1)
})
