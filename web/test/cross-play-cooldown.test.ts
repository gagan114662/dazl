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
import { pgDb, setDb, sqliteDb, type Db } from '../lib/db/client.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { PG_URL, freshSchema, pgSkip } from './helpers/pg-test.ts'

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

// Instinct's #364 review of 2e831b2: direct createDraft / approve / sendMessage (no route, nothing linked beforehand) must
// still be held at the send boundary, before the claim and again after the token refresh, and fail closed when the
// identity cannot be resolved. Stub sender only; nothing leaves the process.
test('direct service calls: unlinked Bob at Jane\'s company is held at send; a different company is sent (control)', async () => {
  const db = await setup()
  const jane = lead(db, play(db, 'A'), 'Acme Roofing', 'jane@acme-roofing.example', 'acme-roofing.example')
  await emailed(db, 'A', jane)
  const bob = lead(db, play(db, 'A'), 'Acme Roofing Ltd', 'bob@acme-roofing.example', 'acme-roofing.example')
  const kim = lead(db, play(db, 'A'), 'Birch Works', 'kim@birch-works.example', 'birch-works.example')
  // Nothing linked Bob: the draft-time rule on the raw handle cannot see the account, so the draft exists.
  const mb = createDraft(db, 'A', bob, 'Acme'); approve(db, 'A', mb)
  const mk = createDraft(db, 'A', kim, 'Acme'); approve(db, 'A', mk)
  const s = sender()
  await assert.rejects(sendMessage(db, 'A', mb, s.deps), /account_contacted_recently/)
  assert.equal(s.sent.length, 0, 'Bob never reaches the sender')
  assert.equal((db.prepare('SELECT status FROM outreach_messages WHERE id = ?').get(mb) as { status: string }).status, 'approved', 'refused before the claim')
  assert.equal(await sendMessage(db, 'A', mk, s.deps), 'sent', 'another company is sent')
  assert.equal(s.sent.length, 1)
})

test('send boundary after the token refresh: an account emailed while the token was fetched holds the send, released, never sent', async () => {
  const db = await setup()
  const p1 = play(db, 'A'), p2 = play(db, 'A')
  const jane = lead(db, p1, 'Acme Roofing', 'jane@acme-roofing.example', 'acme-roofing.example')
  const bob = lead(db, p2, 'Acme Roofing', 'bob@acme-roofing.example', 'acme-roofing.example')
  const mb = createDraft(db, 'A', bob, 'Acme'); approve(db, 'A', mb)
  const s = sender()
  // Another sender emails Jane while this send waits for its access token.
  const racing = (async (url: string) => {
    if (String(url).includes('token')) db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES ('race', 'A', ?, 'jane@acme-roofing.example', 'Quick question', 'A synthetic body that is long enough.', 'sent', ?, ?)").run(jane, NOW, NOW)
    return tokenOk(url)
  }) as unknown as typeof fetch
  await assert.rejects(sendMessage(db, 'A', mb, { ...s.deps, fetchImpl: racing }), /account_contacted_recently/)
  assert.equal(s.sent.length, 0)
  const row = db.prepare('SELECT status, error FROM outreach_messages WHERE id = ?').get(mb) as { status: string; error: string }
  assert.deepEqual([row.status, row.error], ['approved', 'account_contacted_recently'], 'the claim is released, not left sending')
})

test('send boundary fails closed: an identity that cannot be resolved, or is held for review, is never sent', async () => {
  const db = await setup()
  const cedar = lead(db, play(db, 'A'), 'Cedar Works', 'sam@cedar-works.example', 'cedar-works.example')
  const mc = createDraft(db, 'A', cedar, 'Acme'); approve(db, 'A', mc)
  const s = sender()
  db.exec('ALTER TABLE tenant_lead_links RENAME TO tenant_lead_links_unavailable')
  await assert.rejects(sendMessage(db, 'A', mc, s.deps), /identity_unresolved/)
  assert.equal(s.sent.length, 0)
  db.exec('ALTER TABLE tenant_lead_links_unavailable RENAME TO tenant_lead_links')
  assert.equal(await sendMessage(db, 'A', mc, s.deps), 'sent', 'control: once the identity resolves, it is sent')
  // A lead under another company's name whose only key is an email at Pine Studio's domain: it waits for a person.
  lead(db, play(db, 'A'), 'Pine Studio', 'ann@pine-studio.example', 'pine-studio.example')
  const bare = lead(db, play(db, 'A'), 'Dan Consulting', 'dan@pine-studio.example', null)
  await syncAccountGraph(sqliteDb(db), 'A')
  const mbare = createDraft(db, 'A', bare, 'Acme'); approve(db, 'A', mbare)
  await assert.rejects(sendMessage(db, 'A', mbare, s.deps), /identity_review_required/)
  assert.equal(s.sent.length, 1)
})

// With the app on Postgres (DATABASE_URL set) the send boundary resolves identities on the shared Postgres graph: the
// leads are read and linked there, while the emails are still in the SQLite outreach store (the port's in-between state).
test('[pg] send boundary on the shared Postgres graph: Bob held, linked in Postgres; a different company sent', { skip: pgSkip }, async () => {
  const db = await setup()
  const sch = await freshSchema()
  const pg = pgDb({ connectionString: PG_URL!, searchPath: sch.schema, max: 3 })
  try {
    await runPgMigrations(pg.pool)
    setDb(pg)
    const both = async (fn: (d: Db) => Promise<unknown>) => { await fn(sqliteDb(db)); await fn(pg) }
    const ids = { p1: 'f1'.repeat(12), p2: 'f2'.repeat(12), jane: 'e1'.repeat(12), bob: 'e2'.repeat(12), kim: 'e3'.repeat(12) }
    await both(async d => {
      for (const p of [ids.p1, ids.p2]) await d.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, 'A', 'Acme', 'roofing', 'Toronto', 'running')", [p])
      for (const [id, p, company, contact, domain] of [[ids.jane, ids.p1, 'Acme Roofing', 'jane@acme-roofing.example', 'acme-roofing.example'], [ids.bob, ids.p2, 'Acme Roofing', 'bob@acme-roofing.example', 'acme-roofing.example'], [ids.kim, ids.p2, 'Birch Works', 'kim@birch-works.example', 'birch-works.example']]) {
        await d.run('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, company_domain, human_confirmed_at, human_confirmed_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [id, p, company, contact, 'Hiring five roofers', 'https://news.example/a', `${company} is hiring five roofers`, 85, domain, NOW, 'test_review'])
      }
    })
    await emailed(db, 'A', ids.jane)
    const mb = createDraft(db, 'A', ids.bob, 'Acme'); approve(db, 'A', mb)
    const mk = createDraft(db, 'A', ids.kim, 'Acme'); approve(db, 'A', mk)
    const s = sender()
    const onPg = { ...s.deps, env: { ...env, DATABASE_URL: 'postgres://set-for-this-test' } }
    await assert.rejects(sendMessage(db, 'A', mb, onPg), /account_contacted_recently/)
    assert.equal(s.sent.length, 0)
    assert.equal(Number((await pg.get<{ n: number }>("SELECT COUNT(*) AS n FROM tenant_lead_links WHERE tenant_id = 'A' AND status = 'linked'"))?.n), 2, 'Bob and Jane linked in Postgres')
    assert.equal(await sendMessage(db, 'A', mk, onPg), 'sent', 'another company is sent')
    assert.equal(s.sent.length, 1)
  } finally { setDb(null); await pg.close(); await sch.drop() }
})
