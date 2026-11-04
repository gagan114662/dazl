// #355 acceptance, through the REAL tick route (app/api/internal/tick/route.ts) and the REAL scan runner, on in-memory
// SQLite (production's store). Run by test/tenant-load-tick.test.ts with test/helpers/tenant-load-tick-loader.mjs.
//
// Load: tenant A has a 300-thread sent history on a slow Gmail (each thread read takes 150 ms) and a 40-scan backlog,
// queued first, on a model provider that never answers. Tenants B and C have one thread and one scan each; B's thread
// carries an opt-out. One tick must give B and C their reply checks (B's opt-out applied) and their scans (run to done)
// while A's backlog and slow provider are still in flight, and must keep doing so on the next tick. The control runs
// the same load rolled back to the in-process claimer (DAZL_SCAN_SHARED_QUEUE=0): there, A's backlog takes every run
// slot and B's and C's scans starve, which is the bug.
//
// Synthetic data only. Gmail and the model provider are stubs (globalThis.fetch and RunDeps.providers); any other URL
// answers 404 and is recorded, so nothing leaves the process (the net fence is loaded too). The route injects no clock,
// so the wall clock is used.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { flushAfter } from './status-route-next-server-shim.mjs'
import { setScanDb } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { startOAuth, completeOAuth, GMAIL_READ_SCOPE } from '../../lib/gmail/oauth.ts'
import { acceptReadConsent } from '../../lib/outreach/replies.ts'
import { isSuppressed } from '../../lib/outreach/service.ts'
import { saveKey } from '../../lib/llm/key-store.ts'
import { createJob } from '../../lib/scan/store.ts'
import type { RunDeps } from '../../lib/scan/runner.ts'
import { POST } from '../../app/api/internal/tick/route.ts'

const master = randomBytes(32)
process.env.DAZL_ENV = 'test' // not staging: Gmail is really read, through the stub below
process.env.DAZL_MASTER_KEY = master.toString('base64')
process.env.AUTOPILOT_TICK_SECRET = 'test-tick-secret'
process.env.GOOGLE_CLIENT_ID = 'cid.apps.googleusercontent.com'
process.env.GOOGLE_CLIENT_SECRET = 'cs'
process.env.PUBLIC_BASE_URL = 'https://app.test'
process.env.REPLY_SYNC_MAX_THREADS = '25'
process.env.REPLY_SYNC_BUDGET_MS = '1000'
process.env.SCAN_MAX_CONCURRENT = '3'
process.env.SITECRAWL_ENABLED = '0'; process.env.NEWS_SEARCH_ENABLED = '0'
for (const k of ['DAZL_SCAN_SHARED_QUEUE', 'SCAN_PER_TENANT_MAX', 'DAZL_QUEUE_TENANTS', 'AUTOPILOT_ENABLED', 'SEQUENCES_ENABLED', 'ACCOUNT_RETENTION_ENABLED', 'AUDIT_RETENTION_DAYS', 'DATABASE_URL', 'DAZL_TRACE_CAPTURE', 'SCAN_JOB_BUDGET_MS']) delete process.env[k]

const genv = { GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET, PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL }
const KEYS: Record<string, string> = { A: 'sk-ant...AAAA', B: 'sk-ant...BBBB', C: 'sk-ant...CCCC' }
const SLOW_GMAIL_MS = 150
const DAY = 86400
const nowS = () => Math.floor(Date.now() / 1000)
const hex = () => randomBytes(12).toString('hex')
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const until = async (cond: () => boolean, what: string, ms = 15000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(10) } }

// ---- stub Gmail (global fetch): per-thread owner and messages; tenant A's reads are slow ----
const threadOwner = new Map<string, string>()
const threadMessages = new Map<string, unknown[]>()
const reads: Record<string, string[]> = {}
const strays: string[] = []
globalThis.fetch = (async (input: string | URL | Request) => {
  const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (u.includes('oauth2')) return json({ access_token: 'at', expires_in: 3600 })
  const m = u.match(/threads\/([^?/]+)/)
  if (m) {
    const owner = threadOwner.get(m[1]) ?? '?'
    ;(reads[owner] ??= []).push(m[1])
    if (owner === 'A') await sleep(SLOW_GMAIL_MS)
    return json({ messages: threadMessages.get(m[1]) ?? [] })
  }
  if (u.includes('messages?q=') || u.includes('/messages?')) return json({ messages: [] })
  strays.push(u.slice(0, 80))
  return json({}, 404)
}) as typeof fetch

// ---- stub model provider (RunDeps, through tenant-load-runner-shim.ts): A's key never answers until released ----
const QUOTE = 'Northside Builders announced it is hiring three roofing crews for the Toronto market'
const recent = new Date(Date.now() - 30 * DAY * 1000).toISOString().slice(0, 10)
const leadJson = JSON.stringify([{ name: 'Pat', company: 'Northside Builders', contact: null, signal: 'Hiring', source_url: 'https://a.com', score: 80, excerpt: QUOTE, event_date: recent }])
const providerCalls: Record<string, number> = {}
let releaseA: (() => void)[] = []
const research = (key: string) => {
  const t = Object.keys(KEYS).find(k => KEYS[k] === key) ?? '?'
  providerCalls[t] = (providerCalls[t] ?? 0) + 1
  const answer = { text: 'Here: ' + leadJson, citedUrls: ['https://a.com'] }
  if (t === 'A') return new Promise<typeof answer>(r => { releaseA.push(() => r(answer)) })
  return Promise.resolve(answer)
}
const page = async () => ({ text: `News ${recent.slice(0, 4)}. ${QUOTE}. More text.`, title: 'Northside Builders news', retrievedAt: nowS() })
;(globalThis as { __tenantLoadDeps?: RunDeps }).__tenantLoadDeps = { providers: { anthropic: { research }, openai: { research } } as never, master, fetchPage: page, score: false }

function world() {
  const raw = new Database(':memory:')
  migrateAllSqlite(raw)
  setScanDb(raw)
  for (const k of Object.keys(reads)) delete reads[k]
  for (const k of Object.keys(providerCalls)) delete providerCalls[k]
  releaseA = []
  async function onboard(t: string) {
    const email = `me@${t.toLowerCase()}.example`
    raw.prepare("INSERT INTO users (id, email, business_name, password_hash, salt, created_at) VALUES (?, ?, ?, 'x', 'x', ?)").run(t, email, `${t} Co`, nowS())
    const state = new URL(startOAuth(raw, t, { env: genv, now: nowS(), withRead: true })).searchParams.get('state')!
    await completeOAuth(raw, t, 'c', state, { env: genv, master, now: nowS(), fetchImpl: (async () => json({ refresh_token: 'rt', scope: `https://www.googleapis.com/auth/gmail.send ${GMAIL_READ_SCOPE}`, id_token: idToken(email) })) as unknown as typeof fetch })
    acceptReadConsent(raw, t)
    saveKey(raw, t, 'anthropic', KEYS[t], master)
  }
  const leadJob: Record<string, string> = {}
  function sent(t: string, to: string, ageDays: number, reply?: string) {
    // the leads of the sent history belong to an earlier scan, finished once the history is written (finishHistory)
    if (!leadJob[t]) { leadJob[t] = createJob(raw, t, { business_name: 'Acme', industry: 'x', location: 'y' }); raw.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(leadJob[t]) }
    const lead = hex(), mid = hex(), thread = 't-' + mid, at = nowS() - ageDays * DAY
    raw.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(lead, leadJob[t], 'Northside', to, 'Hiring', 'https://n.example/a', 'Northside is hiring', 90)
    raw.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at, gmail_id, thread_id) VALUES (?, ?, ?, ?, 'Quick question', 'bodybodybodybodybodybody', 'sent', ?, ?, ?, ?)").run(mid, t, lead, to, at, at, 'g-' + mid, thread)
    threadOwner.set(thread, t)
    if (reply) threadMessages.set(thread, [{ id: 'r-' + mid, threadId: thread, internalDate: String((nowS() - 60) * 1000), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: to }], body: { data: Buffer.from(reply).toString('base64url') } } }])
  }
  const finishHistory = () => { for (const id of Object.values(leadJob)) raw.prepare("UPDATE scan_jobs SET status = 'done', finished_at = ? WHERE id = ?").run(nowS(), id) }
  const scans = (t: string) => raw.prepare("SELECT id, status FROM scan_jobs WHERE user_id = ? AND business_name = 'Scan'").all(t) as { id: string; status: string }[]
  const scan = (t: string) => createJob(raw, t, { business_name: 'Scan', industry: 'roofing', location: 'Toronto' })
  const count = (t: string, status: string) => scans(t).filter(s => s.status === status).length
  const progress = (t: string, kind: string) => raw.prepare('SELECT last_outcome, last_hold FROM scheduler_progress WHERE tenant_id = ? AND kind = ?').get(t, kind) as { last_outcome: string; last_hold: string | null } | undefined
  async function tick() {
    const res = await POST(new NextRequest('http://localhost/api/internal/tick', { method: 'POST', headers: { authorization: 'Bearer test-tick-secret' } }))
    assert.equal(res.status, 200)
    return await res.json() as { ok: boolean; tenants: number; tenant_failures: number; tenant_holds: number }
  }
  return { raw, onboard, sent, finishHistory, scan, scans, count, progress, tick }
}

async function loaded() {
  const w = world()
  for (const t of ['A', 'B', 'C']) await w.onboard(t)
  for (let i = 0; i < 300; i++) w.sent('A', `p${i}@big.example`, i % 100 + 1)
  w.sent('B', 'buyer@b.example', 2, 'Please remove me from your list')
  w.sent('C', 'buyer@c.example', 3)
  w.finishHistory()
  for (let i = 0; i < 40; i++) w.scan('A') // A's backlog is queued first: the worst order for B and C
  w.scan('B'); w.scan('C')
  return w
}

// Always run after a scenario, passed or failed: the route's queued kick runs (so it cannot fire into the next test's
// store), then A's hung provider calls are released so every run slot is free again.
async function settle(w: { raw: Database.Database }) {
  await flushAfter()
  for (const r of releaseA.splice(0)) r()
  await until(() => (w.raw.prepare("SELECT count(*) AS n FROM scan_jobs WHERE status = 'running'").get() as { n: number }).n === 0, 'running scans settle')
  await sleep(50)
}

test('[sqlite] tick route under tenant load: B and C get their reply checks and their scans while A\'s backlog and slow providers are in flight; again on the next tick', async () => {
  const w = await loaded()
  try { await fairUnderLoad(w) } finally { await settle(w) }
})

async function fairUnderLoad(w: Awaited<ReturnType<typeof loaded>>) {
  const body = await w.tick()
  assert.equal(body.ok, true)
  assert.equal(body.tenant_failures, 0)
  // reply checks: A's slow Gmail is cut by its time budget and cap; B and C are still read in the same tick. (On a
  // steady clock A reads REPLY_SYNC_BUDGET_MS / 150 ms = about 7 threads; the budget itself is pinned with an injected
  // clock in test/reply-sync-fairness.test.ts, so this bound does not lean on the host's wall clock.)
  assert.ok((reads.A?.length ?? 0) >= 1 && reads.A.length <= 25, `A read ${reads.A?.length} threads: bounded, not its 300-thread history`)
  assert.equal(reads.B?.length, 1, "B's reply check ran"); assert.equal(reads.C?.length, 1, "C's reply check ran")
  assert.equal(isSuppressed(w.raw, 'B', 'buyer@b.example'), true, "B's opt-out applied in the same tick")
  assert.deepEqual(w.progress('B', 'reply_sync'), { last_outcome: 'success', last_hold: null })
  assert.deepEqual(w.progress('A', 'reply_sync'), { last_outcome: 'hold', last_hold: 'reply_sync_partial' }, "A's partial read is a hold, never a fresh full read")
  // scans: the route kicks the runner after its response
  assert.deepEqual([w.count('A', 'running'), w.count('B', 'pending'), w.count('C', 'pending')], [0, 1, 1], 'nothing claimed before the post-response kick')
  await flushAfter()
  await until(() => w.count('B', 'done') === 1 && w.count('C', 'done') === 1, "B's and C's scans finish")
  assert.deepEqual([w.count('A', 'running'), w.count('A', 'pending')], [1, 39], 'A holds one run slot (SCAN_PER_TENANT_MAX default 1); its backlog waits')
  assert.equal(providerCalls.A, 1, "A's provider was called once: its backlog did not take B's and C's slots")
  for (const t of ['B', 'C']) {
    const id = w.scans(t)[0].id
    assert.equal((w.raw.prepare('SELECT count(*) AS n FROM leads WHERE scan_job_id = ?').get(id) as { n: number }).n, 1, `${t}'s scan wrote its lead`)
  }
  const aLeads = w.raw.prepare("SELECT count(*) AS n FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.business_name = 'Scan' AND j.user_id = 'A'").get() as { n: number }
  assert.equal(aLeads.n, 0, 'A, still running, has written nothing')
  // the next tick: B's new scan and reply check are served again while A is still busy; A's reads move on (checkpoint)
  const firstReadsA = new Set(reads.A)
  w.scan('B')
  reads.A = []; reads.B = []
  await sleep(1100) // checkpoints are second-granularity
  const body2 = await w.tick()
  assert.equal(body2.tenant_failures, 0)
  assert.equal(reads.B.length, 1)
  assert.ok(reads.A.length >= 1 && reads.A.every(t => !firstReadsA.has(t)), "A's second tick reads new threads, never the ones it already read")
  await flushAfter()
  await until(() => w.count('B', 'done') === 2, "B's second scan finishes")
  assert.deepEqual([w.count('A', 'running'), w.count('A', 'pending'), providerCalls.A], [1, 39, 1], 'the limit holds across ticks and kicks')
  // the queue item settles just after its scan row (the outcome is mapped onto it by claim token)
  await until(() => (w.raw.prepare("SELECT count(*) AS n FROM work_queue WHERE kind = 'scan' AND tenant_id != 'A' AND status = 'claimed'").get() as { n: number }).n === 0, 'B and C items settle')
  const q = w.raw.prepare("SELECT tenant_id, status, count(*) AS n FROM work_queue WHERE kind = 'scan' GROUP BY tenant_id, status ORDER BY tenant_id, status").all()
  assert.deepEqual(q, [{ tenant_id: 'A', status: 'claimed', n: 1 }, { tenant_id: 'A', status: 'pending', n: 39 }, { tenant_id: 'B', status: 'done', n: 2 }, { tenant_id: 'C', status: 'done', n: 1 }], 'durable queue state')
  // the scans' free public sources (feeds, job boards) reached the stub too and got its 404: nothing left the process,
  // and no Gmail request went anywhere but the thread stub
  assert.ok(strays.every(u => !u.includes('googleapis')), 'every Gmail request was a stubbed thread read')
}

test('[sqlite] control, rolled back (DAZL_SCAN_SHARED_QUEUE=0): the same load starves B\'s and C\'s scans behind A\'s backlog', async () => {
  process.env.DAZL_SCAN_SHARED_QUEUE = '0'
  const w = await loaded()
  try {
    const body = await w.tick()
    assert.equal(body.ok, true)
    await flushAfter()
    await until(() => w.count('A', 'running') === 3, "A's scans take the run slots")
    await sleep(300)
    assert.deepEqual([w.count('A', 'running'), w.count('B', 'pending'), w.count('C', 'pending')], [3, 1, 1], "every slot is A's; B and C wait")
    assert.equal(providerCalls.B ?? 0, 0); assert.equal(providerCalls.C ?? 0, 0)
  } finally { await settle(w); delete process.env.DAZL_SCAN_SHARED_QUEUE }
})
