import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { completeOAuth, startOAuth } from '../lib/gmail/oauth.ts'
import { saveSettings, suppress, isSuppressed, type Deps } from '../lib/outreach/service.ts'
import { ATTESTATIONS, CONSENT_VERSION, disable, enable, getState, migrateAutopilot, pause, recentAutopilotAudit, recordBounce, resume, runAutopilot } from '../lib/outreach/autopilot.ts'

const master = randomBytes(32)
const genv = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const ON = { AUTOPILOT_ENABLED: '1', AUTOPILOT_WARMUP: '2' }
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
const tokenOk = (async (url: string) => (String(url).includes('token') ? json({ access_token: 'at' }) : json({}, 404))) as unknown as typeof fetch

async function setup() {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateAutopilot(db)
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
const status = (db: Database.Database) => (db.prepare('SELECT to_email, status FROM outreach_messages ORDER BY created_at, rowid').all() as { to_email: string; status: string }[])

test('off by default; enabling needs current consent, all attestations, sender identity and Gmail', async () => {
  const db = await setup(); const { sent, d } = sends(); lead(db, 'a@one.example')
  assert.equal((await runAutopilot(db, 'A', 'Acme', d)).stopped, 'off')
  assert.throws(() => enable(db, 'A', { version: 'old', attestations: [...ATTESTATIONS] }), /consent_required/)
  assert.throws(() => enable(db, 'A', { version: CONSENT_VERSION, attestations: ['business_published'] }), /consent_required/)
  const bare = new Database(':memory:'); migrateScan(bare); migrateOutreach(bare); migrateAutopilot(bare)
  assert.throws(() => enable(bare, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS] }), /sender_identity_missing/)
  assert.equal(sent.length, 0)
})

test('operator flag and kill switch stop everything', async () => {
  const db = await setup(); ok(db); lead(db, 'a@one.example'); const { sent, d } = sends()
  assert.equal((await runAutopilot(db, 'A', 'Acme', { ...d, flags: {} })).stopped, 'not_available')
  assert.equal((await runAutopilot(db, 'A', 'Acme', { ...d, flags: { ...ON, AUTOPILOT_KILL: '1' } })).stopped, 'not_available')
  assert.equal(sent.length, 0)
})

test('warm-up: the first sends stay drafts for the user; after that autopilot sends', async () => {
  const db = await setup(); ok(db); const { sent, d } = sends()
  lead(db, 'a@one.example'); lead(db, 'b@two.example')
  const r1 = await runAutopilot(db, 'A', 'Acme', d)
  assert.deepEqual([r1.sent, r1.held], [0, 2]); assert.equal(sent.length, 0)
  assert.deepEqual(status(db).map(m => m.status), ['draft', 'draft'])
  db.prepare("UPDATE outreach_messages SET status = 'sent', sent_at = ?, claimed_at = ? WHERE status = 'draft'").run(NOW - 10 * 86400, NOW - 10 * 86400) // user approved and sent two
  lead(db, 'c@three.example')
  const r2 = await runAutopilot(db, 'A', 'Acme', d)
  assert.equal(r2.sent, 1); assert.equal(sent.length, 1)
  const mime = Buffer.from(sent[0], 'base64url').toString(); assert.match(mime, /List-Unsubscribe:/); assert.match(Buffer.from(mime.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString(), /unsubscribe here/i)
  assert.ok(recentAutopilotAudit(db, 'A').some(a => a.action === 'sent'))
})

test('only verified business leads: unverified, low confidence, no email, personal email, suppressed are never sent', async () => {
  const db = await setup(); ok(db); const { sent, d } = sends()
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES ('s1a2b3c4d5e6f7a8b9c0d1e2','A','x1','o1@z.example','s','bodybodybodybodybodybody','sent',?,?),('s2a2b3c4d5e6f7a8b9c0d1e2','A','x2','o2@z.example','s','bodybodybodybodybodybody','sent',?,?)").run(NOW - 9e5, NOW - 9e5, NOW - 9e5, NOW - 9e5)
  lead(db, 'a@one.example', null, null); lead(db, 'b@two.example', 50); lead(db, null); lead(db, 'pat@gmail.com'); const sup = lead(db, 'd@four.example'); suppress(db, 'A', 'd@four.example', 'unsubscribe')
  const good = lead(db, 'e@five.example')
  const r = await runAutopilot(db, 'A', 'Acme', d)
  assert.equal(r.sent, 1); assert.equal(sent.length, 1); assert.ok(Buffer.from(sent[0], 'base64url').toString().includes('To: e@five.example'))
  assert.ok(sup && good)
})

test('daily cap, one email per company per week, and no re-contact', async () => {
  const db = await setup(); ok(db); const { sent, d } = sends() // cap 3
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES ('s1a2b3c4d5e6f7a8b9c0d1e2','A','x1','o1@z.example','s','bodybodybodybodybodybody','sent',?,?),('s2a2b3c4d5e6f7a8b9c0d1e2','A','x2','o2@z.example','s','bodybodybodybodybodybody','sent',?,?)").run(NOW - 9e5, NOW - 9e5, NOW - 9e5, NOW - 9e5)
  for (const e of ['a@one.example', 'b@one.example', 'c@two.example', 'd@three.example', 'e@four.example', 'f@five.example']) lead(db, e)
  const r = await runAutopilot(db, 'A', 'Acme', d)
  assert.equal(r.sent, 3); assert.equal(r.stopped, 'daily_cap'); assert.equal(sent.length, 3)
  const heldDomain = recentAutopilotAudit(db, 'A').filter(a => a.action === 'held_domain_cap')
  assert.equal(heldDomain.length, 1)
  const again = await runAutopilot(db, 'A', 'Acme', d) // same day: nothing more
  assert.equal(again.sent, 0); assert.equal(sent.length, 3)
})

test('pause stops sends at once, bounces suppress and 3 in a day pause, uncertain send pauses', async () => {
  const db = await setup(); ok(db); const { sent, d } = sends()
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES ('s1a2b3c4d5e6f7a8b9c0d1e2','A','x1','o1@z.example','s','bodybodybodybodybodybody','sent',?,?),('s2a2b3c4d5e6f7a8b9c0d1e2','A','x2','o2@z.example','s','bodybodybodybodybodybody','sent',?,?)").run(NOW - 9e5, NOW - 9e5, NOW - 9e5, NOW - 9e5)
  lead(db, 'a@one.example'); pause(db, 'A')
  assert.equal((await runAutopilot(db, 'A', 'Acme', d)).stopped, 'paused'); assert.equal(sent.length, 0)
  resume(db, 'A')
  recordBounce(db, 'A', 'x@bad1.example', NOW); recordBounce(db, 'A', 'x@bad2.example', NOW); assert.equal(getState(db, 'A').paused, false)
  recordBounce(db, 'A', 'x@bad3.example', Math.floor(Date.now() / 1000))
  assert.equal(isSuppressed(db, 'A', 'x@bad1.example'), true)
  assert.equal(getState(db, 'A').paused, true)
  disable(db, 'A'); assert.equal(getState(db, 'A').enabled, false)
})

test('an uncertain send pauses autopilot and nothing else goes out', async () => {
  const db = await setup(); ok(db)
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES ('s1a2b3c4d5e6f7a8b9c0d1e2','A','x1','o1@z.example','s','bodybodybodybodybodybody','sent',?,?),('s2a2b3c4d5e6f7a8b9c0d1e2','A','x2','o2@z.example','s','bodybodybodybodybodybody','sent',?,?)").run(NOW - 9e5, NOW - 9e5, NOW - 9e5, NOW - 9e5)
  lead(db, 'a@one.example'); lead(db, 'b@two.example')
  const d: Deps & { flags: Record<string, string> } = { flags: ON, env: genv, master, now: NOW, baseUrl: 'https://app.test', fetchImpl: tokenOk, sendFn: (async () => { throw new Error('network') }) as never }
  const r = await runAutopilot(db, 'A', 'Acme', d)
  assert.equal(r.stopped, 'uncertain_send'); assert.equal(getState(db, 'A').paused, true)
  assert.equal(status(db).filter(m => m.status === 'uncertain').length, 1)
})
