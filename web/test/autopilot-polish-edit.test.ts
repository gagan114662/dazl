// #929: an owner edit during runAutopilot's polish await is a representation-authority change. Fenced: in-memory DB, stub Gmail, stub model.
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
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { ATTESTATIONS, CONSENT_VERSION, enable, migrateAutopilot, recentAutopilotAudit, runAutopilot } from '../lib/outreach/autopilot.ts'

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
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE confidence IS NOT NULL AND evidence_excerpt IS NOT NULL").run()
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)
  return id
}
const ok = (db: Database.Database) => enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 3 })
// Two old warmup sends (outside every cap window), so the manual warmup gate is cleared.
const warmed = (db: Database.Database) => db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES ('s1a2b3c4d5e6f7a8b9c0d1e2','A','x1','o1@z.example','s','bodybodybodybodybodybody','sent',?,?),('s2a2b3c4d5e6f7a8b9c0d1e2','A','x2','o2@z.example','s','bodybodybodybodybodybody','sent',?,?)").run(NOW - 9e5, NOW - 9e5, NOW - 9e5, NOW - 9e5)
type SendStub = { calls: string[]; d: Deps & { flags: Record<string, string> }; fail: (e: unknown) => void; heal: () => void }
const sendStub = (now: number, firstError?: unknown): SendStub => {
  const calls: string[] = []
  let failure: unknown = firstError
  const d: Deps & { flags: Record<string, string> } = { flags: { ...ON }, env: genv, master, now, baseUrl: 'https://app.test', fetchImpl: tokenOk, sendFn: (async (_t: string, raw: string) => { calls.push(raw); if (failure) { const f = failure; failure = null; throw f } return { id: 'g' } }) as never }
  return { calls, d, fail: (e) => { failure = e }, heal: () => { failure = null } }
}
const work = (db: Database.Database) => db.prepare('SELECT message_id, reason, next_at, attempts FROM autopilot_work ORDER BY created_at, rowid').all() as { message_id: string; reason: string; next_at: number | null; attempts: number }[]
const audits = (db: Database.Database) => recentAutopilotAudit(db, 'A') as { action: string; detail: string | null }[]


const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const OWNER = { subject: 'Owner changed subject', body: 'Owner edited body should stay for review' }
const STALE = 'Subject: Stale model subject\n\nThis stale model rewrite followed an owner edit.\n\nThanks,'
const FRESH = 'Subject: Polished subject\n\nThis polished body replaces the template when nobody edits.\n\nThanks,'
async function run(model: string, edit: boolean | 'aba') {
  const db = await setup(); ok(db); warmed(db); migrateKeys(db); saveKey(db, 'A', 'anthropic', KEY, master); lead(db, 'a@one.example')
  const s = sendStub(NOW)
  const providers = { anthropic: { complete: async () => {
    if (edit === true) db.prepare("UPDATE outreach_messages SET subject = ?, body = ?, words_rev = words_rev + 1 WHERE status = 'draft'").run(OWNER.subject, OWNER.body)
    if (edit === 'aba') { // the owner edits to B and back to the exact original A while the model is awaited; each edit is a words writer
      const a = db.prepare("SELECT subject, body FROM outreach_messages WHERE status = 'draft'").get() as { subject: string; body: string }
      for (const w of [OWNER, a]) db.prepare("UPDATE outreach_messages SET subject = ?, body = ?, words_rev = words_rev + 1 WHERE status = 'draft'").run(w.subject, w.body)
    }
    return model
  } } }
  const out = await runAutopilot(db, 'A', 'Acme', { ...s.d, providers } as never)
  const row = db.prepare("SELECT subject, body, status, approved_hash FROM outreach_messages WHERE to_email = 'a@one.example'").get() as { subject: string; body: string; status: string; approved_hash: string | null }
  return { db, out, s, row }
}

test('owner edit during the await, model UNUSABLE: the owner words are not approved or sent; the draft goes back to the owner intact', async () => {
  const { db, out, s, row } = await run('not usable', true)
  assert.equal(s.calls.length, 0)
  assert.equal(out.sent, 0)
  assert.deepEqual({ subject: row.subject, body: row.body, status: row.status, approved_hash: row.approved_hash }, { ...OWNER, status: 'draft', approved_hash: null })
  assert.equal(work(db).length, 0)
  assert.ok(audits(db).some(a => a.action === 'released' && /edited while autopilot was drafting/.test(a.detail ?? '')))
})

test('owner edit during the await, model USABLE: the stale polish is void, the owner edit is intact and unsent', async () => {
  const { db, s, row } = await run(STALE, true)
  assert.equal(s.calls.length, 0)
  assert.deepEqual({ subject: row.subject, body: row.body, status: row.status, approved_hash: row.approved_hash }, { ...OWNER, status: 'draft', approved_hash: null })
  assert.ok(!row.body.includes('stale model'))
  assert.ok(audits(db).some(a => a.action === 'released'))
})

test('control: no edit during the await, usable model: the polished words apply and send', async () => {
  const { out, s, row } = await run(FRESH, false)
  assert.equal(out.sent, 1)
  assert.equal(s.calls.length, 1)
  assert.equal(row.status, 'sent')
  assert.match(row.body, /polished body replaces the template/)
})

test('control: no edit during the await, unusable model: the template words send as drafted', async () => {
  const { out, s, row } = await run('not usable', false)
  assert.equal(out.sent, 1)
  assert.equal(s.calls.length, 1)
  assert.equal(row.status, 'sent')
  assert.ok(!/Owner edited/.test(row.body))
})

test('A to B to A owner edit during the await (text identical to the original), model USABLE: still an edit, the stale polish is void', async () => {
  const { db, s, row } = await run(STALE, 'aba')
  assert.equal(s.calls.length, 0)
  assert.equal(row.status, 'draft'); assert.equal(row.approved_hash, null)
  assert.ok(!row.body.includes('stale model'))
  assert.ok(audits(db).some(a => a.action === 'released'))
})

test('A to B to A owner edit during the await, model UNUSABLE: returned to the owner, never auto-approved or sent as unchanged', async () => {
  const { db, s, row } = await run('not usable', 'aba')
  assert.equal(s.calls.length, 0)
  assert.equal(row.status, 'draft'); assert.equal(row.approved_hash, null)
  assert.ok(audits(db).some(a => a.action === 'released' && /edited while autopilot was drafting/.test(a.detail ?? '')))
})

test('every words writer bumps words_rev; a plain polish bumps it exactly once', async () => {
  const { db } = await run(FRESH, false)
  assert.equal((db.prepare("SELECT words_rev AS r FROM outreach_messages WHERE to_email = 'a@one.example'").get() as { r: number }).r, 1)
})

test('DB invariant: a subject/body change that does not bump words_rev is refused; a bumped write, and a no-op write, pass', async () => {
  const { db } = await run(FRESH, false)
  const upd = (sql: string) => db.prepare(sql).run()
  assert.throws(() => upd("UPDATE outreach_messages SET body = 'a direct write that forgot the revision, long enough' WHERE to_email = 'a@one.example'"), /words_rev not bumped/)
  assert.throws(() => upd("UPDATE outreach_messages SET subject = 'forgot the revision' WHERE to_email = 'a@one.example'"), /words_rev not bumped/)
  upd("UPDATE outreach_messages SET body = 'a bumped write, long enough to pass', words_rev = words_rev + 1 WHERE to_email = 'a@one.example'")
  upd("UPDATE outreach_messages SET subject = subject, body = body WHERE to_email = 'a@one.example'") // unchanged words need no bump
})
