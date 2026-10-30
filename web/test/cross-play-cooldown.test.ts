// Cross-play outreach cooldowns (lib/accounts/cooldown.ts, #364) on the real draft and send path. Synthetic tenants,
// plays, companies and addresses; Gmail is a stub and nothing leaves the process.
import { seedOffers } from './helpers/seed-offer.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { completeOAuth, startOAuth } from '../lib/gmail/oauth.ts'
import { approve, createDraft, saveSettings, sendMessage, type Deps } from '../lib/outreach/service.ts'
import { syncAccountGraph } from '../lib/accounts/graph.ts'
import { cooldownDays, crossPlayHold } from '../lib/accounts/cooldown.ts'
import { sqliteDb } from '../lib/db/client.ts'

const master = randomBytes(32)
const env = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'csecret', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = Math.floor(Date.now() / 1000)
const DAY = 86400
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'

async function setup(tenants = ['A']) {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); seedOffers(db); migrateConnectors(db)
  for (const t of tenants) {
    const state = new URL(startOAuth(db, t, { env, now: NOW })).searchParams.get('state')!
    await completeOAuth(db, t, 'code', state, { env, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: 'openid email https://www.googleapis.com/auth/gmail.send', id_token: idToken(`me@${t.toLowerCase()}-sender.example`) })) as unknown as typeof fetch })
    saveSettings(db, t, { sender_name: 'Pat Smith', postal_address: '1 King St W, Toronto ON M5H 1A1, Canada' })
  }
  return db
}
function play(db: Database.Database, tenant: string) {
  const job = createJob(db, tenant, { business_name: 'Acme', industry: 'roofing', location: 'Toronto' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  return job
}
function lead(db: Database.Database, job: string, company: string, contact: string, domain: string | null) {
  const id = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, company_domain, human_confirmed_at, human_confirmed_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, job, company, contact, 'Hiring five roofers', 'https://news.example/a', `${company} is hiring five roofers`, 85, domain, NOW, 'test_review')
  return id
}
const tokenOk = (async (url: string) => (String(url).includes('token') ? json({ access_token: 'at-1' }) : json({}, 404))) as unknown as typeof fetch
const sender = () => { const sent: string[] = []; return { sent, deps: { env, master, now: NOW, baseUrl: 'https://app.test', fetchImpl: tokenOk, sendFn: (async (_t: string, raw: string) => { sent.push(raw); return { id: 'gm' + sent.length } }) as never } satisfies Deps } }
async function emailed(db: Database.Database, tenant: string, leadId: string) {
  const id = createDraft(db, tenant, leadId, 'Acme'); approve(db, tenant, id)
  const s = sender()
  assert.equal(await sendMessage(db, tenant, id, s.deps), 'sent')
  return id
}
const code = (fn: () => unknown) => { try { fn(); return null } catch (e) { return (e as { code?: string }).code ?? String(e) } }

test('the same person found by a second play is not emailed again within the recipient cooldown; another tenant is not affected', async () => {
  const db = await setup(['A', 'B'])
  const a = lead(db, play(db, 'A'), 'Acme Roofing', 'jane@acme-roofing.example', 'acme-roofing.example')
  await emailed(db, 'A', a)
  const again = lead(db, play(db, 'A'), 'ACME Roofing Inc', 'Jane@acme-roofing.example', null)
  assert.equal(code(() => createDraft(db, 'A', again, 'Acme')), 'recipient_contacted_recently')
  // Tenant B's own play may email the same address: cooldowns are the tenant's own history.
  const b = lead(db, play(db, 'B'), 'Acme Roofing', 'jane@acme-roofing.example', 'acme-roofing.example')
  assert.equal(code(() => createDraft(db, 'B', b, 'Acme')), null)
  // After the window it is allowed again; a zero window turns the rule off.
  assert.equal(crossPlayHold(db, 'A', again, 'jane@acme-roofing.example', { now: NOW + 91 * DAY }), null)
  assert.equal(crossPlayHold(db, 'A', again, 'jane@acme-roofing.example', { now: NOW, env: { DAZL_RECIPIENT_COOLDOWN_DAYS: '0' } }), null)
  assert.deepEqual(cooldownDays({}), { recipient: 90, account: 30 })
  assert.deepEqual(cooldownDays({ DAZL_RECIPIENT_COOLDOWN_DAYS: 'x', DAZL_ACCOUNT_COOLDOWN_DAYS: '-1' }), { recipient: 90, account: 30 }, 'a bad setting keeps the default')
})

test('someone else at the same canonical account, found by another play, waits for the account cooldown; only once the lead is linked', async () => {
  const db = await setup()
  const p1 = play(db, 'A'), p2 = play(db, 'A')
  const jane = lead(db, p1, 'Acme Roofing', 'jane@acme-roofing.example', 'acme-roofing.example')
  await emailed(db, 'A', jane)
  const bob = lead(db, p2, 'Acme Roofing Ltd', 'bob@acme-roofing.example', 'acme-roofing.example')
  // Not yet linked to an account: only the recipient rule applies, and bob is another person.
  assert.equal(crossPlayHold(db, 'A', bob, 'bob@acme-roofing.example'), null)
  await syncAccountGraph(sqliteDb(db), 'A')
  assert.equal(code(() => createDraft(db, 'A', bob, 'Acme')), 'account_contacted_recently')
  assert.equal(crossPlayHold(db, 'A', bob, 'bob@acme-roofing.example', { now: NOW + 31 * DAY }), null)
  // Same-name business on another website: a different account, not held.
  const other = lead(db, p2, 'Acme Roofing', 'kim@acme-roofing-west.example', 'acme-roofing-west.example')
  await syncAccountGraph(sqliteDb(db), 'A')
  assert.equal(code(() => createDraft(db, 'A', other, 'Acme')), null)
  // A same-name lead with no website is quarantined: never guessed onto the account, so only the recipient rule holds it.
  const bare = lead(db, p2, 'Acme Roofing', 'lee@roofers-mail.example', null)
  await syncAccountGraph(sqliteDb(db), 'A')
  assert.equal(crossPlayHold(db, 'A', bare, 'lee@roofers-mail.example'), null)
})

test('two plays approved the same person before either sent: the second is refused at send, kept approved, and never reaches Gmail', async () => {
  const db = await setup()
  const x = lead(db, play(db, 'A'), 'Acme Roofing', 'jane@acme-roofing.example', 'acme-roofing.example')
  const y = lead(db, play(db, 'A'), 'Acme Roofing', 'jane@acme-roofing.example', 'acme-roofing.example')
  const mx = createDraft(db, 'A', x, 'Acme'), my = createDraft(db, 'A', y, 'Acme')
  approve(db, 'A', mx); approve(db, 'A', my)
  const s = sender()
  assert.equal(await sendMessage(db, 'A', mx, s.deps), 'sent')
  await assert.rejects(sendMessage(db, 'A', my, s.deps), /recipient_contacted_recently/)
  assert.equal(s.sent.length, 1)
  assert.equal((db.prepare('SELECT status FROM outreach_messages WHERE id = ?').get(my) as { status: string }).status, 'approved')
})

test('a send with an unknown outcome counts as contacted', async () => {
  const db = await setup()
  const x = lead(db, play(db, 'A'), 'Acme Roofing', 'jane@acme-roofing.example', 'acme-roofing.example')
  const mx = createDraft(db, 'A', x, 'Acme'); approve(db, 'A', mx)
  db.prepare("UPDATE outreach_messages SET status = 'uncertain', claimed_at = ? WHERE id = ?").run(NOW, mx)
  const y = lead(db, play(db, 'A'), 'Acme Roofing', 'jane@acme-roofing.example', 'acme-roofing.example')
  assert.equal(crossPlayHold(db, 'A', y, 'jane@acme-roofing.example'), 'recipient_contacted_recently')
  // A draft that never went out does not.
  db.prepare("UPDATE outreach_messages SET status = 'draft' WHERE id = ?").run(mx)
  assert.equal(crossPlayHold(db, 'A', y, 'jane@acme-roofing.example'), null)
})
