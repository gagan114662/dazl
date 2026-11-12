import { migrateConnectors } from '../lib/connectors/store.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { completeOAuth, startOAuth, GMAIL_READ_SCOPE } from '../lib/gmail/oauth.ts'
import { saveSettings, isSuppressed } from '../lib/outreach/service.ts'
import { ATTESTATIONS, CONSENT_VERSION, enable, migrateAutopilot } from '../lib/outreach/autopilot.ts'
import { hasConsent, migrateLedger } from '../lib/outreach/ledger.ts'
import { acceptReadConsent, migrateReplies, syncReplies } from '../lib/outreach/replies.ts'

const master = randomBytes(32)
const genv = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const DAY = 86400
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
const SEND = 'https://www.googleapis.com/auth/gmail.send'

async function setup(withRead = true) {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db)
  const state = new URL(startOAuth(db, 'A', { env: genv, now: NOW, withRead })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', state, { env: genv, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: `${SEND}${withRead ? ' ' + GMAIL_READ_SCOPE : ''}`, id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
  saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 5 })
  acceptReadConsent(db, 'A')
  return db
}
function sentLead(db: Database.Database, to: string, sentAt = NOW - 4 * DAY) {
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const lead = randomBytes(12).toString('hex'), mid = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(lead, job, 'Northside', to, 'Hiring roofers', 'https://n.example/a', 'Northside is hiring', 90)
  // Test baseline is explicitly human-reviewed; no machine timing inference.
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE confidence IS NOT NULL AND evidence_excerpt IS NOT NULL").run()
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at, gmail_id, thread_id) VALUES (?, 'A', ?, ?, 'Quick question', 'bodybodybodybodybodybody', 'sent', ?, ?, ?, ?)").run(mid, lead, to, sentAt, sentAt, 'g-' + mid, 't-' + mid)
  return { lead, mid, thread: 't-' + mid }
}
import { sameThreadDsn } from './helpers/dsn-fixture.ts'
const msg = (id: string, from: string, body: string, at: number, extra: { name: string; value: string }[] = []) => ({ id, threadId: 't', internalDate: String(at * 1000), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: from }, ...extra], body: { data: Buffer.from(body).toString('base64url') } } })
function gmail(threads: Record<string, unknown[]>, calls: string[] = []) {
  return (async (url: string) => {
    const u = String(url); calls.push(u)
    if (u.includes('oauth2')) return json({ access_token: 'at' })
    const m = u.match(/threads\/([^?]+)/); if (m) return json({ messages: threads[m[1]] ?? [] })
    if (u.includes('messages?q=')) return json({ messages: [] }) // no daemon notices in these fixtures
    return json({}, 404)
  }) as unknown as typeof fetch
}


// Read-side authority + same-thread DSN provenance (Refs #928, #415, #739). Fenced: in-memory DB, stubbed Gmail, no provider.
const count = (db: Database.Database, sql: string) => (db.prepare(sql).get() as { n: number }).n
const revokeRead = (db: Database.Database) => db.prepare("DELETE FROM mail_read_consent WHERE tenant_id = 'A'").run()
function hooked(threads: Record<string, unknown[]>, hooks: { onToken?: () => void; onThread?: () => void }, calls: string[] = []) {
  const base = gmail(threads, calls)
  return (async (url: string, init?: unknown) => {
    const u = String(url)
    if (u.includes('oauth2')) hooks.onToken?.()
    else if (/threads\//.test(u)) hooks.onThread?.()
    return (base as unknown as (u: string, i?: unknown) => Promise<Response>)(url, init)
  }) as unknown as typeof fetch
}
const reply = (id: string) => msg(id, 'Pat <p@one.example>', 'Sounds good, send me more info', NOW - 2 * DAY)
const opts = (fetchImpl: typeof fetch) => ({ env: genv, master, now: NOW, fetchImpl })

test('control: consent intact, a positive reply is stored and grants followup consent', async () => {
  const db = await setup(); const p = sentLead(db, 'p@one.example')
  const r = await syncReplies(db, 'A', opts(gmail({ [p.thread]: [reply('m1')] })))
  assert.equal(r.error, undefined)
  assert.equal(r.consents, 1)
  assert.equal(hasConsent(db, 'A', 'p@one.example', 'email', 'followup', NOW), true)
})

test('read consent revoked during the token await: no thread read, nothing stored, no followup consent', async () => {
  const db = await setup(); const p = sentLead(db, 'p@one.example'); const calls: string[] = []
  const r = await syncReplies(db, 'A', opts(hooked({ [p.thread]: [reply('m1')] }, { onToken: () => revokeRead(db) }, calls)))
  assert.equal(r.error, 'reading_not_enabled')
  assert.equal(calls.filter(u => /threads\//.test(u)).length, 0)
  assert.equal(count(db, 'SELECT count(*) n FROM inbound_messages'), 0)
  assert.equal(hasConsent(db, 'A', 'p@one.example', 'email', 'followup', NOW), false)
})

test('read consent revoked during the thread fetch await: the fetched reply is discarded, no consent granted', async () => {
  const db = await setup(); const p = sentLead(db, 'p@one.example')
  const r = await syncReplies(db, 'A', opts(hooked({ [p.thread]: [reply('m1')] }, { onThread: () => revokeRead(db) })))
  assert.equal(r.error, 'reading_not_enabled')
  assert.equal(r.consents, 0)
  assert.equal(count(db, 'SELECT count(*) n FROM inbound_messages'), 0)
  assert.equal(count(db, "SELECT count(*) n FROM consent_ledger WHERE contact = 'p@one.example'"), 0)
  assert.equal(hasConsent(db, 'A', 'p@one.example', 'email', 'followup', NOW), false)
})

test('connection replaced (same address, new refresh token) mid-sync: fail closed, nothing read after, nothing stored', async () => {
  const db = await setup(); const p = sentLead(db, 'p@one.example'); const calls: string[] = []
  const swap = () => db.prepare("UPDATE gmail_accounts SET refresh_ct = 'other-connection' WHERE tenant_id = 'A'").run()
  const r = await syncReplies(db, 'A', opts(hooked({ [p.thread]: [reply('m1')] }, { onThread: swap }, calls)))
  assert.equal(r.error, 'reading_not_enabled')
  assert.equal(count(db, 'SELECT count(*) n FROM inbound_messages'), 0)
  assert.equal(hasConsent(db, 'A', 'p@one.example', 'email', 'followup', NOW), false)
})

test('connection disconnected during the token await: no read, no store', async () => {
  const db = await setup(); const p = sentLead(db, 'p@one.example'); const calls: string[] = []
  const r = await syncReplies(db, 'A', opts(hooked({ [p.thread]: [reply('m1')] }, { onToken: () => db.prepare("UPDATE gmail_accounts SET status = 'needs_reconnect' WHERE tenant_id = 'A'").run() }, calls)))
  assert.equal(r.error, 'reading_not_enabled')
  assert.equal(calls.filter(u => /threads\//.test(u)).length, 0)
  assert.equal(count(db, 'SELECT count(*) n FROM inbound_messages'), 0)
})

const bounceThread = (db: Database.Database, to: string, m: unknown) => { const b = sentLead(db, to); return { b, th: { [b.thread]: [m] } } }

test('same-thread forged daemon From with a plain 5.1.1 body: no suppression, no counted bounce, one review item', async () => {
  const db = await setup()
  const { th } = bounceThread(db, 'b@three.example', msg('f1', 'Mail Delivery <mailer-daemon@evil.example>', 'Delivery failed. 550 5.1.1 user unknown', NOW - 3 * DAY))
  const r = await syncReplies(db, 'A', opts(gmail(th)))
  assert.deepEqual([r.bounces, r.reviews], [0, 1])
  assert.equal(isSuppressed(db, 'A', 'b@three.example'), false)
  assert.equal(count(db, "SELECT count(*) n FROM inbound_messages WHERE classification = 'bounce'"), 0)
  assert.equal(count(db, "SELECT count(*) n FROM inbound_messages WHERE classification = 'bounce_review'"), 1)
  const again = await syncReplies(db, 'A', opts(gmail(th))); assert.equal(again.reviews, 0) // once per send
})

test('same-thread structured DSN without authenticated provenance (or from an unrelated domain) is review only', async () => {
  for (const authResults of [null, 'mx.google.com; spf=pass smtp.mailfrom=attacker.example']) {
    const db = await setup()
    const { th } = bounceThread(db, 'b@three.example', sameThreadDsn('f2', { recipient: 'b@three.example', at: NOW - 3 * DAY, authResults, from: 'postmaster@attacker.example' }))
    const r = await syncReplies(db, 'A', opts(gmail(th)))
    assert.deepEqual([r.bounces, r.reviews], [0, 1])
    assert.equal(isSuppressed(db, 'A', 'b@three.example'), false)
  }
})

test('same-thread structured DSN naming a different recipient cannot suppress the one we wrote to', async () => {
  const db = await setup()
  const { th } = bounceThread(db, 'b@three.example', sameThreadDsn('f3', { recipient: 'someone.else@three.example', at: NOW - 3 * DAY }))
  const r = await syncReplies(db, 'A', opts(gmail(th)))
  assert.equal(r.bounces, 0)
  assert.equal(isSuppressed(db, 'A', 'b@three.example'), false)
})

test('control: same-thread structured DSN with aligned provenance suppresses, recorded as dsn, counted once', async () => {
  const db = await setup()
  const b = sentLead(db, 'b@three.example')
  const th = { [b.thread]: [sameThreadDsn('f4', { recipient: 'b@three.example', at: NOW - 3 * DAY, ref: `<dazl.${b.mid}@acme.example>` })] }
  const r = await syncReplies(db, 'A', opts(gmail(th)))
  assert.equal(r.bounces, 1)
  assert.equal(isSuppressed(db, 'A', 'b@three.example'), true)
  const again = await syncReplies(db, 'A', opts(gmail(th))); assert.equal(again.bounces, 0)
})

// #415 review (2026-11-06): thread membership is not correlation. A same-thread notice must reference THIS send by its
// own structured fields (returned Message-ID / References), the same contract as the separate-thread branch, before a
// correlated, authenticated 5.x.x can suppress. Everything else is one review item, never a suppression or a count.
test('same-thread authenticated DSN WITHOUT an exact reference to this send: review only, nobody suppressed', async () => {
  const cases: { name: string; o: (mid: string, other: string) => { ref?: string; refHeader?: string } }[] = [
    { name: 'no reference at all', o: () => ({}) },
    { name: 'references another real send to the same recipient', o: (_m, other) => ({ ref: `<dazl.${other}@acme.example>` }) },
    { name: 'this send id on a foreign domain', o: m => ({ ref: `<dazl.${m}@evil.example>` }) },
    { name: 'fabricated dazl id', o: () => ({ ref: '<dazl.deadbeef00@acme.example>' }) },
    { name: 'ambiguous: this send and another', o: (m, other) => ({ ref: `<dazl.${m}@acme.example>`, refHeader: `<dazl.${other}@acme.example>` }) },
    { name: 'non-dazl message id', o: () => ({ ref: '<CAF123@mail.gmail.com>' }) },
  ]
  for (const c of cases) {
    const db = await setup()
    const b = sentLead(db, 'b@three.example'), other = sentLead(db, 'b@three.example', NOW - 5 * DAY)
    const th = { [b.thread]: [sameThreadDsn('f7', { recipient: 'b@three.example', at: NOW - 3 * DAY, ...c.o(b.mid, other.mid) })] }
    const r = await syncReplies(db, 'A', opts(gmail(th)))
    assert.deepEqual([r.bounces, r.reviews], [0, 1], c.name)
    assert.equal(isSuppressed(db, 'A', 'b@three.example'), false, c.name)
    assert.equal(count(db, "SELECT count(*) n FROM inbound_messages WHERE classification = 'bounce'"), 0, c.name)
    assert.equal(count(db, "SELECT count(*) n FROM inbound_messages WHERE classification = 'bounce_review'"), 1, c.name)
    assert.equal(count(db, "SELECT count(*) n FROM followup_threads WHERE stopped = 'bounce'"), 0, c.name)
    const again = await syncReplies(db, 'A', opts(gmail(th))); assert.equal(again.reviews, 0, c.name) // once per send
  }
})

test('control: same-thread reference via a follow-up step id or the References header still correlates to the original send', async () => {
  for (const o of [(m: string) => ({ ref: `<dazl.f1.${m}@acme.example>` }), (m: string) => ({ refHeader: `<dazl.${m}@acme.example> <dazl.s2.${m}@ACME.example>` })]) {
    const db = await setup()
    const b = sentLead(db, 'b@three.example')
    const r = await syncReplies(db, 'A', opts(gmail({ [b.thread]: [sameThreadDsn('f8', { recipient: 'b@three.example', at: NOW - 3 * DAY, ...o(b.mid) })] })))
    assert.deepEqual([r.bounces, r.reviews], [1, 0])
    assert.equal(isSuppressed(db, 'A', 'b@three.example'), true)
  }
})

test('control: a daemon message without any 5.x.x stays a soft bounce', async () => {
  const db = await setup()
  const { th } = bounceThread(db, 's@four.example', msg('f5', 'postmaster@four.example', 'Mailbox full 4.2.2', NOW - 3 * DAY))
  const r = await syncReplies(db, 'A', opts(gmail(th)))
  assert.deepEqual([r.bounces, r.reviews], [0, 0])
  assert.equal(isSuppressed(db, 'A', 's@four.example'), false)
  assert.equal(count(db, "SELECT count(*) n FROM inbound_messages WHERE classification = 'soft_bounce'"), 1)
})

test('same-thread matched recipient block says delayed / 4.x.x: stays soft even with unrelated 5.x.x text elsewhere', async () => {
  for (const o of [{ action: 'delayed', status: '4.4.7' }, { action: 'failed', status: '4.2.2' }]) {
    const db = await setup()
    const m = sameThreadDsn('f6', { recipient: 'b@three.example', at: NOW - 3 * DAY, ...o })
    m.payload.parts.unshift({ mimeType: 'text/plain', body: { data: Buffer.from('Another recipient other@x.example failed: 550 5.1.1 user unknown').toString('base64url') } })
    const r = await syncReplies(db, 'A', opts(gmail({ [sentLead(db, 'b@three.example').thread]: [m] })))
    assert.deepEqual([r.bounces, r.reviews], [0, 0])
    assert.equal(count(db, "SELECT count(*) n FROM inbound_messages WHERE classification = 'soft_bounce'"), 1)
    assert.equal(count(db, "SELECT count(*) n FROM inbound_messages WHERE classification = 'bounce_review'"), 0)
  }
})

test('disconnect racing a sync: the account is gone before provider revocation resolves, the sync stores nothing', async () => {
  const { disconnectGmail } = await import('../lib/gmail/oauth.ts')
  const db = await setup(); const p = sentLead(db, 'p@one.example'); const calls: string[] = []
  let release!: () => void
  const revokeFetch = (async () => { await new Promise<void>(r => { release = r }); return json({}) }) as unknown as typeof fetch
  let pending: Promise<void> | undefined
  const r = await syncReplies(db, 'A', opts(hooked({ [p.thread]: [reply('m1')] }, { onToken: () => { pending = disconnectGmail(db, 'A', { env: genv, master, fetchImpl: revokeFetch }) } }, calls)))
  // #740/#930: the token fetch itself now refuses a connection deleted mid-call (gmail_unavailable), before the
  // read-authority recheck would (reading_not_enabled). Either way: no thread read, nothing stored.
  assert.ok(r.error === 'gmail_unavailable' || r.error === 'reading_not_enabled', String(r.error))
  assert.equal(calls.filter(u => /threads\//.test(u)).length, 0)
  assert.equal(count(db, 'SELECT count(*) n FROM inbound_messages'), 0)
  assert.equal(count(db, "SELECT count(*) n FROM gmail_accounts WHERE tenant_id = 'A'"), 0) // deleted while revoke still pending
  release(); await pending
})
