import { seedOffers } from './helpers/seed-offer.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { completeOAuth, startOAuth } from '../lib/gmail/oauth.ts'
import { saveSettings, type Deps } from '../lib/outreach/service.ts'
import { ATTESTATIONS, CONSENT_VERSION, disable, enable, getState, migrateAutopilot, recentAutopilotAudit, resume, runAutopilot } from '../lib/outreach/autopilot.ts'
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
