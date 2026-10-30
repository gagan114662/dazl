// Bounded, checkpointed reply reading (lib/outreach/replies.ts, #355): a tenant with a long sent history next to a small
// one, with a slow and a failing mailbox. Synthetic tenants and addresses; Gmail is a stub, nothing is sent or fetched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { createJob } from '../lib/scan/store.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { completeOAuth, startOAuth, GMAIL_READ_SCOPE } from '../lib/gmail/oauth.ts'
import { saveSettings, isSuppressed } from '../lib/outreach/service.ts'
import { ATTESTATIONS, CONSENT_VERSION, enable } from '../lib/outreach/autopilot.ts'
import { grantConsent } from '../lib/outreach/ledger.ts'
import { acceptReadConsent, autopilotReplyTenants, REPLY_FRESH_S, syncReplies, type SyncDeps } from '../lib/outreach/replies.ts'
import { runFollowups, setFollowups } from '../lib/outreach/followups.ts'

const master = randomBytes(32)
const genv = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const DAY = 86400
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
const SEND = 'https://www.googleapis.com/auth/gmail.send'

async function tenant(db: Database.Database, id: string) {
  db.prepare("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'Pat', 'Biz', 'x', 'x')").run(id, `${id}@owner.example`)
  const state = new URL(startOAuth(db, id, { env: genv, now: NOW, withRead: true })).searchParams.get('state')!
  await completeOAuth(db, id, 'c', state, { env: genv, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: `${SEND} ${GMAIL_READ_SCOPE}`, id_token: idToken(`me@${id}.example`) })) as unknown as typeof fetch })
  saveSettings(db, id, { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  enable(db, id, { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 50 })
  acceptReadConsent(db, id)
  setFollowups(db, id, true)
  const job = createJob(db, id, { business_name: 'Biz', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  return job
}
function sent(db: Database.Database, t: string, job: string, to: string, sentAt: number) {
  const lead = randomBytes(12).toString('hex'), mid = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, human_confirmed_at, human_confirmed_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(lead, job, 'Northside', to, 'Hiring roofers', 'https://n.example/a', 'Northside is hiring', 90, NOW, 'test_review')
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at, gmail_id, thread_id) VALUES (?, ?, ?, ?, 'Quick question', 'bodybodybodybodybodybody', 'sent', ?, ?, ?, ?)")
    .run(mid, t, lead, to, sentAt, sentAt, 'g-' + mid, 't-' + mid)
  return { lead, mid, thread: 't-' + mid }
}
// An interested reply already read: a follow-up thread that can still trigger a send.
function interested(db: Database.Database, t: string, s: { lead: string; thread: string }, to: string) {
  db.prepare("INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, last_lead_reply_at) VALUES (?, ?, ?, ?, 'root', ?, ?)").run(t, s.thread, s.lead, to, NOW - 8 * DAY, NOW - 8 * DAY)
  grantConsent(db, t, to, { channel: 'email', scope: 'followup', basis: 'reply_interest', evidenceRef: 'gmail:x', now: NOW - 8 * DAY })
}
const msg = (id: string, from: string, body: string, at: number) => ({ id, threadId: 't', internalDate: String(at * 1000), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: from }], body: { data: Buffer.from(body).toString('base64url') } } })
// Gmail stub: thread contents by id, a per-thread failure, and every thread read recorded.
function gmail(threads: Record<string, unknown[]>, opts: { fail?: Set<string>; reads?: string[] } = {}) {
  return (async (url: string) => {
    const u = String(url)
    if (u.includes('oauth2')) return json({ access_token: 'at' })
    const m = u.match(/threads\/([^?]+)/)
    if (m) { opts.reads?.push(m[1]); return opts.fail?.has(m[1]) ? json({}, 503) : json({ messages: threads[m[1]] ?? [] }) }
    return json({}, 404)
  }) as unknown as typeof fetch
}
const deps = (now: number, f: typeof fetch, extra: Partial<SyncDeps> = {}): SyncDeps => ({ env: genv, master, now, fetchImpl: f, ...extra })

test('a long history next to a small one: each sync reads a bounded number of threads, send-capable ones first, then rotates through the rest', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const jobL = await tenant(db, 'L'), jobS = await tenant(db, 'S')
  const big = Array.from({ length: 200 }, (_, i) => sent(db, 'L', jobL, `p${i}@l${i}.example`, NOW - 10 * DAY - i * 3600))
  // The oldest thread of the long history is the one that can still send: it is read first anyway.
  interested(db, 'L', big[199], 'p199@l199.example')
  const small = Array.from({ length: 3 }, (_, i) => sent(db, 'S', jobS, `q${i}@s${i}.example`, NOW - DAY))
  // An opt-out sits in a thread the first sync of L does not reach; it is not inferred absent, it is read later.
  const optOut = big[150]
  const threads = { [optOut.thread]: [msg('oo', 'p150@l150.example', 'Please remove me from your list', NOW - DAY)] }
  const seen = new Map<string, number>()
  for (let pass = 0; pass < 5; pass++) {
    const at = NOW + pass * 600
    const order = autopilotReplyTenants(db).map(t => t.tenant_id)
    for (const t of order) {
      const reads: string[] = []
      const r = await syncReplies(db, t, deps(at, gmail(threads, { reads })))
      assert.equal(r.error, undefined)
      if (t === 'S') { assert.deepEqual([r.threads, r.partial, r.remaining], [3, false, 0], `pass ${pass}: the small tenant is read in full every sync`); continue }
      assert.equal(reads.length, 40, `pass ${pass}: the long history is cut at the bound`)
      assert.equal(reads[0], big[199].thread, `pass ${pass}: the send-capable thread is read first`)
      assert.deepEqual([r.partial, r.remaining], [true, 160])
      for (const th of reads.slice(1)) seen.set(th, (seen.get(th) ?? 0) + 1)
    }
    if (pass === 0) {
      assert.deepEqual(order, ['L', 'S'], 'never-read tenants by id')
      assert.equal(isSuppressed(db, 'L', 'p150@l150.example'), false, 'not reached yet: nothing inferred')
    }
  }
  // Five syncs of 39 rotating reads cover all 199 other threads (195 reads), each at most once, before any repeats.
  assert.equal(seen.size, 195)
  assert.ok([...seen.values()].every(n => n === 1), 'no thread reread before every thread was read once')
  assert.equal(isSuppressed(db, 'L', 'p150@l150.example'), true, 'the opt-out was read on a later sync')
  for (const s of small) assert.equal((db.prepare("SELECT checked_at FROM reply_sync_checks WHERE tenant_id = 'S' AND message_id = ?").get(s.mid) as { checked_at: number }).checked_at, NOW + 4 * 600)
})

test('a slow mailbox stops at the time bound; a failing thread keeps its old checkpoint and its follow-up waits; the next sync retries it', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const job = await tenant(db, 'L')
  const a = sent(db, 'L', job, 'a@one.example', NOW - 10 * DAY), b = sent(db, 'L', job, 'b@two.example', NOW - 10 * DAY)
  interested(db, 'L', a, 'a@one.example'); interested(db, 'L', b, 'b@two.example')
  for (let i = 0; i < 10; i++) sent(db, 'L', job, `c${i}@three.example`, NOW - 20 * DAY)
  // Provider latency: every Gmail call takes 25 s of the 60 s bound.
  let ms = 0
  const slow = gmail({})
  const timed = (async (u: string) => { if (!String(u).includes('oauth2')) ms += 25_000; return slow(u) }) as unknown as typeof fetch
  const r = await syncReplies(db, 'L', deps(NOW, timed, { clockMs: () => ms }))
  assert.deepEqual([r.threads, r.partial, r.remaining, r.error], [3, true, 9, undefined], '25 s per read: three started inside 60 s')
  // The two follow-up threads were read first; a failure on b leaves b unread.
  const reads: string[] = []
  const r2 = await syncReplies(db, 'L', deps(NOW + 7 * DAY, gmail({}, { fail: new Set([b.thread]), reads }), { maxThreads: 5 }))
  assert.equal(r2.error, 'reply_sync_failed')
  assert.deepEqual(reads.slice(0, 2).sort(), [a.thread, b.thread].sort())
  const sends: string[] = []
  const sendFn = (async (_t: string, raw: string) => { sends.push(Buffer.from(raw, 'base64url').toString().match(/^To: (.*)$/m)![1].trim()); return { id: 'f' + sends.length } }) as never
  // Run directly (the tick itself skips a tenant whose sync failed): only the freshly read thread can send.
  const f = await runFollowups(db, 'L', 'Biz', { flags: { AUTOPILOT_ENABLED: '1' }, env: genv, master, now: NOW + 7 * DAY, baseUrl: 'https://app.test', fetchImpl: gmail({}), sendFn })
  assert.deepEqual(sends, ['a@one.example'], 'b was not read: nothing is known about a reply since, so nothing goes to b')
  assert.equal(f.sent, 1)
  // Gap recovery: the next sync reads b again (it keeps priority).
  const later = NOW + 8 * DAY
  const r3 = await syncReplies(db, 'L', deps(later, gmail({}), { maxThreads: 5 }))
  assert.equal(r3.error, undefined)
  // A read older than the send window counts as no read: past it, b still waits.
  const stale = later + REPLY_FRESH_S + 1
  assert.equal((await runFollowups(db, 'L', 'Biz', { flags: { AUTOPILOT_ENABLED: '1' }, env: genv, master, now: stale, baseUrl: 'https://app.test', fetchImpl: gmail({}), sendFn })).sent, 0, 'stale read: no follow-up')
  await syncReplies(db, 'L', deps(stale, gmail({}), { maxThreads: 5 }))
  const f3 = await runFollowups(db, 'L', 'Biz', { flags: { AUTOPILOT_ENABLED: '1' }, env: genv, master, now: stale, baseUrl: 'https://app.test', fetchImpl: gmail({}), sendFn })
  assert.equal(f3.sent, 1)
  assert.deepEqual(sends, ['a@one.example', 'b@two.example'])
})

test('a tick cut short serves the tenants it did not reach first next time', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  for (const t of ['A', 'B', 'C']) { const j = await tenant(db, t); sent(db, t, j, `x@${t.toLowerCase()}.example`, NOW - DAY) }
  assert.deepEqual(autopilotReplyTenants(db).map(t => t.tenant_id), ['A', 'B', 'C'])
  // The first tick reached only A, then lost its lease.
  await syncReplies(db, 'A', deps(NOW, gmail({})))
  assert.deepEqual(autopilotReplyTenants(db).map(t => t.tenant_id), ['B', 'C', 'A'])
  await syncReplies(db, 'B', deps(NOW + 60, gmail({})))
  assert.deepEqual(autopilotReplyTenants(db).map(t => t.tenant_id), ['C', 'A', 'B'])
})
