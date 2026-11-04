// #355: bounded, checkpointed, tenant-fair reply reading (lib/outreach/replies.ts syncReplies). A tenant with a long
// sent history must not consume the serial tick before another tenant's reply checks, must not re-read its whole
// 120-day history every tick, must always read the threads an automated send can still reach, and must never be
// taken as "read" after a partial traversal. Synthetic data and a stubbed Gmail only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { completeOAuth, startOAuth, GMAIL_READ_SCOPE } from '../lib/gmail/oauth.ts'
import { isSuppressed, saveSettings } from '../lib/outreach/service.ts'
import { ATTESTATIONS, CONSENT_VERSION, enable, migrateAutopilot } from '../lib/outreach/autopilot.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { acceptReadConsent, migrateReplies, replySyncLimits, syncReplies, REPLY_SYNC_DEFAULT_BUDGET_MS, REPLY_SYNC_DEFAULT_MAX_THREADS } from '../lib/outreach/replies.ts'
import { migrateSequences } from '../lib/outreach/sequences.ts'
import { classifySync, migrateSchedulerRuns, recordProgress } from '../lib/ops/scheduler-runs.ts'
import { replySafetyStale } from '../lib/outreach/store.ts'

const master = randomBytes(32)
const genv = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const DAY = 86400
const SEND = 'https://www.googleapis.com/auth/gmail.send'
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'

async function store(tenants: string[]) {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db); migrateSequences(db)
  for (const t of tenants) {
    const state = new URL(startOAuth(db, t, { env: genv, now: NOW, withRead: true })).searchParams.get('state')!
    await completeOAuth(db, t, 'c', state, { env: genv, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: `${SEND} ${GMAIL_READ_SCOPE}`, id_token: idToken(`me@${t.toLowerCase()}.example`) })) as unknown as typeof fetch })
    saveSettings(db, t, { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
    enable(db, t, { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 5 })
    acceptReadConsent(db, t)
  }
  return db
}
const jobs = new WeakMap<Database.Database, Map<string, string>>()
function sent(db: Database.Database, tenant: string, to: string, sentAt: number) {
  const per = jobs.get(db) ?? new Map<string, string>(); jobs.set(db, per)
  let job = per.get(tenant)
  if (!job) { job = createJob(db, tenant, { business_name: 'Acme', industry: 'x', location: 'y' }); db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job); per.set(tenant, job) }
  const lead = randomBytes(12).toString('hex'), mid = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(lead, job, 'Northside', to, 'Hiring', 'https://n.example/a', 'Northside is hiring', 90)
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at, gmail_id, thread_id) VALUES (?, ?, ?, ?, 'Quick question', 'bodybodybodybodybodybody', 'sent', ?, ?, ?, ?)").run(mid, tenant, lead, to, sentAt, sentAt, 'g-' + mid, 't-' + mid)
  return { lead, mid, thread: 't-' + mid }
}
const msg = (id: string, from: string, body: string, at: number) => ({ id, threadId: 't', internalDate: String(at * 1000), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: from }], body: { data: Buffer.from(body).toString('base64url') } } })
// a stub Gmail: per-thread messages, optional per-thread failure, and a clock that each thread read advances by delayMs
function gmail(o: { threads?: Record<string, unknown[]>; fail?: Set<string>; delayMs?: number; clock?: { t: number } } = {}) {
  const reads: string[] = []
  const f = (async (url: string) => {
    const u = String(url)
    if (u.includes('oauth2')) return json({ access_token: 'at' })
    const m = u.match(/threads\/([^?]+)/)
    if (m) { reads.push(m[1]); if (o.clock) o.clock.t += o.delayMs ?? 0; if (o.fail?.has(m[1])) return json({}, 500); return json({ messages: o.threads?.[m[1]] ?? [] }) }
    if (u.includes('messages?q=')) return json({ messages: [] })
    return json({}, 404)
  }) as unknown as typeof fetch
  return { f, reads }
}
const sync = (db: Database.Database, tenant: string, g: { f: typeof fetch }, env: Record<string, string> = {}, clock?: { t: number }) =>
  syncReplies(db, tenant, { env: { ...genv, ...env }, master, now: NOW, fetchImpl: g.f, ...(clock ? { clockMs: () => clock.t } : {}) })

test('one tick, two tenants: the 300-thread tenant reads at most its cap, the small tenant still gets its reply check and its opt-out applied', async () => {
  const db = await store(['A', 'B'])
  for (let i = 0; i < 300; i++) sent(db, 'A', `p${i}@big.example`, NOW - (i % 100 + 1) * DAY)
  const small = sent(db, 'B', 'buyer@small.example', NOW - 2 * DAY)
  const g = gmail({ threads: { [small.thread]: [msg('r1', 'buyer@small.example', 'Please remove me from your list', NOW - 60)] } })
  // the tick's serial loop, big tenant first (the worst order for the small one)
  const a = await sync(db, 'A', g, { REPLY_SYNC_MAX_THREADS: '25' })
  const b = await sync(db, 'B', g, { REPLY_SYNC_MAX_THREADS: '25' })
  assert.equal(g.reads.filter(t => t !== small.thread).length, 25, 'tenant A read 25 threads this tick, not 300')
  assert.equal(a.threads, 25); assert.equal(a.remaining, 275); assert.equal(a.neverRead, 275); assert.equal(a.error, undefined)
  assert.deepEqual(classifySync(a), { outcome: 'hold', reason: 'reply_sync_partial' }, 'a partial read is never recorded as a fresh full read')
  assert.ok(g.reads.includes(small.thread)); assert.equal(b.optOuts, 1); assert.equal(isSuppressed(db, 'B', 'buyer@small.example'), true)
  assert.deepEqual(classifySync(b), { outcome: 'success' })
  // tenant scoping: B's call stamped only B's rows
  assert.equal((db.prepare("SELECT count(*) AS n FROM outreach_messages WHERE tenant_id = 'A' AND reply_checked_at IS NOT NULL").get() as { n: number }).n, 25)
  assert.equal((db.prepare("SELECT count(*) AS n FROM outreach_messages WHERE tenant_id = 'B' AND reply_checked_at IS NOT NULL").get() as { n: number }).n, 1)
})

test('checkpoints: every background thread is read once per pass (never-read first, then oldest check), no thread re-read before all are', async () => {
  const db = await store(['A'])
  const ids = Array.from({ length: 60 }, (_, i) => sent(db, 'A', `p${i}@big.example`, NOW - (i + 1) * DAY).thread)
  const g = gmail()
  const results = []
  for (let call = 0; call < 3; call++) results.push(await sync(db, 'A', g, { REPLY_SYNC_MAX_THREADS: '20' }))
  assert.deepEqual(results.map(r => r.remaining), [40, 40, 40], 'each call leaves 40 unread')
  assert.deepEqual(results.map(r => r.neverRead), [40, 20, undefined], 'never-read threads go first: after the third call every thread has been read')
  assert.deepEqual(results.map(r => classifySync(r).outcome), ['hold', 'hold', 'success'], 'no freshness until every thread was read once')
  assert.equal(new Set(g.reads).size, 60, 'all 60 read'); assert.equal(g.reads.length, 60, 'none twice within the pass')
  assert.deepEqual(new Set(g.reads), new Set(ids))
  await sync(db, 'A', g, { REPLY_SYNC_MAX_THREADS: '20' })
  assert.deepEqual(g.reads.slice(60), g.reads.slice(0, 20), 'the next pass starts with the oldest checks')
  // a bounded read is fresh only as of its OLDEST thread read, never "now": the 2 h send-side gate keeps its meaning
  db.prepare("UPDATE outreach_messages SET reply_checked_at = ? WHERE tenant_id = 'A'").run(NOW - 3 * 3600)
  const later = await sync(db, 'A', g, { REPLY_SYNC_MAX_THREADS: '20' })
  assert.equal(later.freshAsOf, NOW - 3 * 3600); assert.deepEqual(classifySync(later), { outcome: 'success', freshAsOf: NOW - 3 * 3600 })
  migrateSchedulerRuns(db)
  await recordProgress(db, 'run-1', 'A', 'reply_sync', classifySync(later), NOW)
  assert.equal((db.prepare("SELECT last_success_at FROM scheduler_progress WHERE tenant_id = 'A' AND kind = 'reply_sync'").get() as { last_success_at: number }).last_success_at, NOW - 3 * 3600, 'recorded as of the oldest read')
  assert.equal(replySafetyStale(db, 'A', 'p0@big.example', NOW), true, 'threads unread for 3 h: a send to a contacted recipient holds, as if no full read had happened for 3 h')
  // once a whole pass has gone by again, the success time is recent and the gate opens
  for (let call = 0; call < 3; call++) await recordProgress(db, 'run-2', 'A', 'reply_sync', classifySync(await sync(db, 'A', g, { REPLY_SYNC_MAX_THREADS: '20' })), NOW)
  assert.equal(replySafetyStale(db, 'A', 'p0@big.example', NOW), false)
})

test('due threads (an active sequence, a warm follow-up thread) are read on every call, before the cap and regardless of age', async () => {
  const db = await store(['A'])
  for (let i = 0; i < 30; i++) sent(db, 'A', `p${i}@big.example`, NOW - (i + 1) * DAY)
  const seqMsg = sent(db, 'A', 'seq@lead.example', NOW - 200 * DAY) // older than the 120-day window
  db.prepare("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status) VALUES ('s1', 'A', ?, ?, 'seq@lead.example', 'active')").run(seqMsg.lead, seqMsg.mid)
  const warm = sent(db, 'A', 'warm@lead.example', NOW - 150 * DAY)
  db.prepare("INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, last_lead_reply_at) VALUES ('A', ?, ?, 'warm@lead.example', 'r', ?, ?)").run(warm.thread, warm.lead, NOW - 10 * DAY, NOW - 10 * DAY)
  const stopped = sent(db, 'A', 'stopped@lead.example', NOW - 150 * DAY)
  db.prepare("INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, last_lead_reply_at, stopped) VALUES ('A', ?, ?, 'stopped@lead.example', 'r', ?, ?, 'opt_out')").run(stopped.thread, stopped.lead, NOW - 10 * DAY, NOW - 10 * DAY)
  // a reply arrives on the sequence thread: it must be seen on this very call even with a cap of 1
  const g = gmail({ threads: { [seqMsg.thread]: [msg('r1', 'seq@lead.example', 'Sounds good, call me', NOW - 30)] } })
  for (let call = 0; call < 3; call++) {
    const before = g.reads.length
    const r = await sync(db, 'A', g, { REPLY_SYNC_MAX_THREADS: '1' })
    const these = g.reads.slice(before)
    assert.deepEqual(these.slice(0, 2).sort(), [seqMsg.thread, warm.thread].sort(), `call ${call}: both due threads first`)
    assert.equal(these.length, 3, 'plus exactly one background thread'); assert.ok(!these.includes(stopped.thread), 'a stopped thread is not due and is outside the window')
    assert.equal(r.remaining, 29); assert.equal(r.neverRead, 29 - call)
  }
  assert.equal((db.prepare("SELECT status FROM sequences WHERE id = 's1'").get() as { status: string }).status, 'replied', 'the reply on the old sequence thread stopped the sequence')
})

test('slow provider: the budget ends the call; due threads unread make it fail closed (incomplete), background ones are only remaining', async () => {
  const db = await store(['A'])
  for (let i = 0; i < 10; i++) sent(db, 'A', `p${i}@big.example`, NOW - (i + 1) * DAY)
  const dues = Array.from({ length: 3 }, (_, i) => { const s = sent(db, 'A', `seq${i}@lead.example`, NOW - DAY); db.prepare("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status) VALUES (?, 'A', ?, ?, ?, 'active')").run(`s${i}`, s.lead, s.mid, `seq${i}@lead.example`); return s })
  // every thread read takes 20 s; budget 30 s: the third due thread is never reached
  let clock = { t: 0 }
  let g = gmail({ delayMs: 20_000, clock })
  let r = await sync(db, 'A', g, { REPLY_SYNC_BUDGET_MS: '30000' }, clock)
  assert.equal(r.error, 'reply_sync_incomplete'); assert.equal(classifySync(r).outcome, 'failure', 'the tick sends nothing for this tenant')
  assert.equal(g.reads.length, 2, 'bounded: 2 reads (the second crosses the budget), never all 13')
  assert.ok(g.reads.every(t => dues.some(d => d.thread === t)), 'due threads first')
  // enough budget for the due threads but not the background: no error, the rest is remaining
  clock = { t: 0 }; g = gmail({ delayMs: 20_000, clock })
  r = await sync(db, 'A', g, { REPLY_SYNC_BUDGET_MS: '70000' }, clock)
  assert.equal(r.error, undefined); assert.equal(r.remaining, 9, '3 due + 1 background read, 9 background remaining'); assert.equal(classifySync(r).outcome, 'hold')
})

test('a failed thread read keeps no checkpoint and is first in line next time; the call fails closed', async () => {
  const db = await store(['A'])
  const bad = sent(db, 'A', 'bad@x.example', NOW - DAY)
  for (let i = 0; i < 5; i++) sent(db, 'A', `p${i}@big.example`, NOW - (i + 2) * DAY)
  const g = gmail({ fail: new Set([bad.thread]) })
  const r = await sync(db, 'A', g, { REPLY_SYNC_MAX_THREADS: '2' })
  assert.equal(r.error, 'reply_sync_failed'); assert.equal(classifySync(r).outcome, 'failure')
  assert.equal((db.prepare('SELECT reply_checked_at FROM outreach_messages WHERE id = ?').get(bad.mid) as { reply_checked_at: number | null }).reply_checked_at, null)
  const g2 = gmail()
  await sync(db, 'A', g2, { REPLY_SYNC_MAX_THREADS: '2' })
  assert.equal(g2.reads[0], bad.thread, 'the never-read (failed) thread is read first on the next call')
})

test('limits: malformed or out-of-range values fall back to the defaults, never an unbounded or zero cap', () => {
  const d = { maxThreads: REPLY_SYNC_DEFAULT_MAX_THREADS, budgetMs: REPLY_SYNC_DEFAULT_BUDGET_MS }
  assert.deepEqual(replySyncLimits({}), d)
  for (const v of ['', 'abc', '0', '-1', '1e3', '1001', '99999999', '2.5', ' ', '0x10']) assert.equal(replySyncLimits({ REPLY_SYNC_MAX_THREADS: v }).maxThreads, d.maxThreads, JSON.stringify(v))
  for (const v of ['', 'abc', '999', '600001', '-5', 'Infinity']) assert.equal(replySyncLimits({ REPLY_SYNC_BUDGET_MS: v }).budgetMs, d.budgetMs, JSON.stringify(v))
  assert.equal(replySyncLimits({ REPLY_SYNC_MAX_THREADS: ' 7 ' }).maxThreads, 7)
  assert.equal(replySyncLimits({ REPLY_SYNC_MAX_THREADS: '1000', REPLY_SYNC_BUDGET_MS: '1000' }).maxThreads, 1000)
  assert.deepEqual(classifySync({ neverRead: 0 }), { outcome: 'success' })
  assert.deepEqual(classifySync({ neverRead: 3, error: 'reply_sync_failed' }).outcome, 'failure', 'an error wins over a partial read')
  for (const bad of [NaN, Infinity, -Infinity]) assert.deepEqual(classifySync({ freshAsOf: bad }), { outcome: 'success' }, 'a non-finite time is never recorded')
})
