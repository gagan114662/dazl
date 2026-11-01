// #417 route level (workspace-session-loader.mjs): an unverified password signup queues a PENDING conversion
// and cancels nothing; the verification link and the reset link each activate the conversion at the ownership
// boundary; a verified sign-in re-drains after a lost activation; tampered and unknown links change nothing.
// Token consumption order is exercised through the real routes (peek before consume). No mail leaves the process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, scryptSync } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb } from './tenant-route-db.ts'
import { withJar } from './pg-session-headers.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { createJob } from '../../lib/scan/store.ts'

globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call ${String(u)}`) }) as typeof fetch
process.env.SYSTEM_MAIL_SMTP_URL = 'smtp://fixture.invalid'; process.env.SYSTEM_MAIL_FROM = 'fixture@example.test'
const { setTransportForTests } = await import('../../lib/system-mail.ts')

const raw = new Database(':memory:')
migrateAllSqlite(raw)
setScanDb(raw)
setTransportForTests(async m => { raw.prepare('INSERT INTO system_mail_outbox (id,user_id,to_email,subject,body,created_at) VALUES (?,?,?,?,?,?)').run(crypto.randomUUID(), (raw.prepare('SELECT id FROM users WHERE email = ?').get(m.to) as { id: string } | undefined)?.id ?? 'fixture', m.to, m.subject, m.text, Math.floor(Date.now() / 1000)) })

const signup = await import('../../app/api/auth/signup/route.ts')
const verify = await import('../../app/api/auth/verify/route.ts')
const resetRequest = await import('../../app/api/auth/reset/request/route.ts')
const reset = await import('../../app/api/auth/reset/route.ts')
const signin = await import('../../app/api/auth/signin/route.ts')

let ip = 0
const req = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost', 'x-forwarded-for': `10.9.0.${++ip}` }, body: JSON.stringify(body) })
const link = (to: string, path: string) => {
  const rows = raw.prepare('SELECT body FROM system_mail_outbox WHERE to_email = ? ORDER BY rowid DESC').all(to) as { body: string }[]
  return rows.map(r => new RegExp(`/${path}#t=([a-f0-9]{64})`).exec(r.body)?.[1]).find(Boolean)
}
const BODY = 'bodybodybodybodybodybody'
// Queued automated acquisition work addressed to `email`: a scheduler-held first touch + an active sequence.
const seedWork = (email: string, tag: string) => {
  const job = createJob(raw, 'T', { business_name: 'Acme', industry: 'x', location: 'y' })
  raw.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const lead = randomBytes(12).toString('hex')
  raw.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(lead, job, `Co ${tag}`, email, 'Hiring', 'https://n.example/a', 'Co is hiring', 90, 80)
  raw.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, hold_reason, hold_until) VALUES (?, 'T', ?, ?, 'hi', ?, 'draft', 'warmup_manual', 1800000100)").run(`m-${tag}`, lead, email, BODY)
  raw.prepare("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status) VALUES (?, 'T', ?, ?, ?, 'active')").run(`sq-${tag}`, lead, `m-${tag}`, email)
  return `m-${tag}`
}
const msgStatus = (id: string) => (raw.prepare('SELECT status FROM outreach_messages WHERE id = ?').get(id) as { status: string }).status
const events = (email: string) => raw.prepare('SELECT kind, activated_at FROM lifecycle_events WHERE email = ? ORDER BY created_at').all(email) as { kind: string; activated_at: number | null }[]

test('unverified signup queues a PENDING conversion only; the verification link activates the cancel', async () => {
  const m = seedWork('newprospect@example.test', 'a')
  const su = await withJar(new Map(), () => signup.POST(req('/api/auth/signup', { email: 'newprospect@example.test', password: 'a strong password 1', name: 'N', business_name: 'N Co' })))
  assert.equal(su.status, 200)
  assert.equal((raw.prepare("SELECT email_verified_at FROM users WHERE email = 'newprospect@example.test'").get() as { email_verified_at: number | null }).email_verified_at, null)
  assert.deepEqual(events('newprospect@example.test'), [{ kind: 'signup', activated_at: null }], 'durable pending conversion, nothing activated')
  assert.equal(msgStatus(m), 'draft', 'unverified typed email cancels nothing')

  const token = link('newprospect@example.test', 'verify')!
  assert.ok(token, 'a verification link went to the address')
  const v = await verify.POST(req('/api/auth/verify', { token }))
  assert.deepEqual(await v.json(), { ok: true })
  assert.equal(msgStatus(m), 'skipped', 'ownership proven: the queued work stops')
  assert.equal((raw.prepare('SELECT error FROM outreach_messages WHERE id = ?').get(m) as { error: string }).error, 'converted_signup')
  assert.equal((raw.prepare("SELECT status FROM sequences WHERE id = 'sq-a'").get() as { status: string }).status, 'stopped')
  assert.deepEqual(events('newprospect@example.test').map(e => e.activated_at !== null), [true])
  // The link is spent: a replay cannot re-run anything.
  assert.equal((await verify.POST(req('/api/auth/verify', { token }))).status, 410)
})

test('a reset link proves ownership too: queued signup AND payment conversions both activate', async () => {
  const m = seedWork('resetprospect@example.test', 'b')
  const su = await withJar(new Map(), () => signup.POST(req('/api/auth/signup', { email: 'resetprospect@example.test', password: 'a strong password 2', name: 'R', business_name: 'R Co' })))
  assert.equal(su.status, 200)
  // A payment arrived while the account was still unverified: durable pending, nothing canceled.
  raw.prepare("INSERT INTO lifecycle_events (event_key, kind, email, account_tenant, created_at, activated_at) VALUES ('payment|resetprospect@example.test', 'payment', 'resetprospect@example.test', NULL, 1800000000, NULL)").run()
  assert.equal(msgStatus(m), 'draft')
  const rr = await resetRequest.POST(req('/api/auth/reset/request', { email: 'resetprospect@example.test' }))
  assert.equal(rr.status, 200)
  const token = link('resetprospect@example.test', 'reset')!
  const ok = await reset.POST(req('/api/auth/reset', { token, password: 'another strong password 3' }))
  assert.equal(ok.status, 200)
  assert.equal(msgStatus(m), 'skipped', 'reset proved ownership: the queued work stops')
  const rEv = events('resetprospect@example.test')
  assert.deepEqual(rEv.map(e => e.kind).sort(), ['activation', 'payment', 'signup'], 'signup + payment pending, activation recorded at the boundary')
  assert.ok(rEv.every(e => e.activated_at !== null), 'every conversion activated')
})

test('a verified sign-in re-drains after a lost activation', async () => {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync('a strong password 4', salt, 64).toString('hex')
  raw.prepare("INSERT INTO users (id, email, name, business_name, password_hash, salt, email_verified_at) VALUES ('U4', 'drain@example.test', 'D', 'D Co', ?, ?, 100)").run(hash, salt)
  const m = seedWork('drain@example.test', 'c')
  // The verification boundary's activation write was lost (captured, signup/verify succeeded): the row stays pending.
  raw.prepare("INSERT INTO lifecycle_events (event_key, kind, email, account_tenant, created_at, activated_at) VALUES ('signup|drain@example.test', 'signup', 'drain@example.test', 'U4', 1800000000, NULL)").run()
  assert.equal(msgStatus(m), 'draft')
  const si = await withJar(new Map(), () => signin.POST(req('/api/auth/signin', { email: 'drain@example.test', password: 'a strong password 4' })))
  assert.equal(si.status, 200)
  assert.equal(msgStatus(m), 'skipped', 'the sign-in drain completed the lost activation before any later send')
  assert.equal(events('drain@example.test')[0].activated_at !== null, true)
})

test('tampered and unknown links activate nothing', async () => {
  const m = seedWork('safe@example.test', 'd')
  assert.equal((await verify.POST(req('/api/auth/verify', { token: 'f'.repeat(64) }))).status, 410)
  assert.equal((await reset.POST(req('/api/auth/reset', { token: 'e'.repeat(64), password: 'a strong password 5' }))).status, 410)
  assert.equal(msgStatus(m), 'draft')
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM lifecycle_events WHERE email = 'safe@example.test'").get() as { n: number }).n, 0, 'no conversion recorded for the untouched address')
})
console.log('AUTH LIFECYCLE ROUTES ok')
