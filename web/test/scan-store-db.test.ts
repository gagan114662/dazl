// Scan job store on the Db layer (lib/scan/store-db.ts, step 1 of "Plan: scan jobs to Postgres"). On SQLite and
// Postgres: two tenants, each function scoped to its owner (tenant B never reads, counts, exports or cancels A's jobs
// or leads), the stale reaper, and cancel. On SQLite the new functions are pinned to the sync store.ts ones the app
// still calls, on the same rows.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { sqliteDb, type Db } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import * as S from '../lib/scan/store-db.ts'
import * as Legacy from '../lib/scan/store.ts'
import { bothEngines } from './helpers/engines.ts'

const A = 'a'.repeat(32), B = 'b'.repeat(32)
const T0 = 1_800_000_000

// Every lead carries page timing (published_at, timing_note), so reads, exports and parity cover both columns.
async function lead(db: Db, jobId: string, id: string, o: { fit?: number | null; quarantined?: boolean; kind?: string; created?: number } = {}) {
  await db.run(`INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, fit, quarantined_at, source_kind, created_at, published_at, timing_note) VALUES (?, ?, 'Pat', ?, 'Hiring', ?, 60, ?, ?, ?, ?, ?, ?)`,
    [id, jobId, `Co ${id}`, `https://e.example/${id}`, o.fit ?? null, o.quarantined ? T0 : null, o.kind ?? null, o.created ?? T0, '2026-09-30', `published 2026-09-30 (${id})`])
}
// A tenant with one finished scan (visible, hidden, quarantined and fixture leads), one query scan and one CSV job.
async function fixture(db: Db, tenant: string, tag: string) {
  const done = await S.createJob(db, tenant, { business_name: `Biz ${tag}`, industry: 'software', location: 'Toronto' }, null, T0)
  await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1, claimed_at = ? WHERE id = ?", [T0, done])
  await lead(db, done, `${tag}-good`, { fit: 4, created: T0 + 1 })
  await lead(db, done, `${tag}-low`, { fit: 1 })
  await lead(db, done, `${tag}-quar`, { fit: 5, quarantined: true })
  await lead(db, done, `${tag}-fixture`, { fit: 3, kind: 'test' })
  await db.run("UPDATE scan_jobs SET status = 'done', finished_at = ?, claimed_at = NULL WHERE id = ?", [T0 + 5, done])
  const query = await S.createQueryJob(db, tenant, { query: `find ${tag} buyers`, icp: '{"x":1}', runBudget: null }, T0 + 10)
  const csv = await S.createJob(db, tenant, { business_name: `Csv ${tag}`, industry: 'software', location: 'Toronto' }, null, T0 + 20)
  await db.run('UPDATE scan_jobs SET csv_domain = ? WHERE id = ?', [`${tag}.example`, csv])
  return { done, query, csv }
}

bothEngines('scan store on Db: each tenant reads, counts and exports only its own jobs and leads', async ({ db }) => {
  const a = await fixture(db, A, 'a'), b = await fixture(db, B, 'b')
  assert.equal((await S.getJob(db, A, a.done))!.lead_count, 4)
  assert.equal(await S.getJob(db, B, a.done), undefined) // A's job id, B's session
  assert.deepEqual((await S.listLeads(db, A, a.done)).map(l => l.id), ['a-quar', 'a-good', 'a-fixture']) // fit order; hidden fit<=1 out
  assert.deepEqual((await S.listLeads(db, A, a.done, 200, true)).map(l => l.id), ['a-quar', 'a-good', 'a-fixture', 'a-low'])
  assert.deepEqual(await S.listLeads(db, B, a.done), [])
  // page timing is part of the read and export contract
  const good = (await S.listLeads(db, A, a.done)).find(l => l.id === 'a-good')!
  assert.deepEqual([good.published_at, good.timing_note], ['2026-09-30', 'published 2026-09-30 (a-good)'])
  const ex = (await S.exportLeads(db, A))[0]
  assert.deepEqual([ex.lead_id, ex.published_at, ex.timing_note], ['a-good', '2026-09-30', 'published 2026-09-30 (a-good)'])
  assert.equal(await S.countHiddenLeads(db, A, a.done), 1)
  assert.equal(await S.countHiddenLeads(db, B, a.done), 0)
  assert.deepEqual((await S.listJobs(db, A)).map(j => [j.id, Number(j.lead_count)]), [[a.csv, 0], [a.query, 0], [a.done, 4]])
  assert.ok((await S.listJobs(db, B)).every(j => j.id !== a.done && j.id !== a.query))
  assert.equal(await S.latestJobId(db, A), a.csv)
  assert.equal(await S.latestJobId(db, B), b.csv)
  assert.deepEqual(await S.latestQueryJob(db, A), { query: 'find a buyers', icp: '{"x":1}', icp_inferred: 0 })
  // export: no hidden, no quarantined, no fixtures unless asked; never another tenant's rows
  assert.deepEqual((await S.exportLeads(db, A)).map(r => r.lead_id), ['a-good'])
  assert.deepEqual((await S.exportLeads(db, A, a.done, 5000, true)).map(r => r.lead_id).sort(), ['a-fixture', 'a-good'])
  assert.deepEqual(await S.exportLeads(db, B, a.done), [])
  assert.deepEqual((await S.exportLeads(db, B)).map(r => r.lead_id), ['b-good'])
  // active jobs: the query scan is pending; CSV jobs do not count
  assert.equal(await S.countActiveJobs(db, A, T0 + 30), 1)
})

bothEngines("cancel: B cannot cancel A's job; A's pending scan is cancelled through the legal transitions and keeps its slot", async ({ db }) => {
  const a = await fixture(db, A, 'a')
  assert.deepEqual(await S.cancelJob(db, B, a.query, T0 + 40), { ok: false, reason: 'not_found' })
  assert.equal((await S.getJob(db, A, a.query))!.status, 'pending')
  assert.deepEqual(await S.cancelJob(db, A, a.csv, T0 + 40), { ok: false, reason: 'not_cancellable' })
  assert.deepEqual(await S.cancelJob(db, A, a.done, T0 + 40), { ok: false, reason: 'already_finished' })
  assert.deepEqual(await S.cancelJob(db, A, a.query, T0 + 40), { ok: true, was_running: false })
  const j = (await S.getJob(db, A, a.query))!
  assert.deepEqual([j.status, j.error, Number(j.attempts), Number(j.finished_at)], ['failed', 'cancelled', 1, T0 + 40])
  assert.equal(await S.countActiveJobs(db, A, T0 + 40 + Legacy.CANCEL_HOLD_S - 1), 1) // still holds its slot
  assert.equal(await S.countActiveJobs(db, A, T0 + 40 + Legacy.CANCEL_HOLD_S + 1), 0)
  assert.deepEqual(await S.cancelJob(db, A, a.query, T0 + 41), { ok: false, reason: 'already_finished' })
})

bothEngines('cancel: a PENDING job with a RESERVED spend call is cancelled through legal transitions; the reserved row is never touched and no claimer takes the job after', async ({ db }) => {
  const id = await S.createQueryJob(db, A, { query: 'find acme buyers', icp: '{"x":1}', runBudget: null }, T0)
  await db.run("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, status, created_at) VALUES ('c1', ?, ?, 0, 'llm.anthropic', 0.05, 'reserved', ?)", [A, id, T0])
  const r = await S.cancelJob(db, A, id, T0 + 1)
  assert.deepEqual(r, { ok: true, was_running: false }, 'a pending job cancels through the legal pending->running->failed path in one tx')
  const j = (await db.get<{ status: string; error: string | null; attempts: number }>('SELECT status, error, attempts FROM scan_jobs WHERE id = ?', [id]))!
  assert.deepEqual(j, { status: 'failed', error: 'cancelled', attempts: 1 }, 'terminal cancelled state, exactly one (the cancelling) attempt')
  const call = (await db.get<{ status: string }>('SELECT status FROM scan_spend_calls WHERE id = ?', ['c1']))!
  assert.equal(call.status, 'reserved', 'the unsettled call is NEVER auto-settled or deleted by a cancel: possibly billed stays possibly billed')
  assert.deepEqual(await S.cancelJob(db, A, id, T0 + 2), { ok: false, reason: 'already_finished' }, 'a cancelled job is terminal: it can never be re-cancelled or re-claimed')
  // The reaper runs with a far-future clock: a genuinely stale RUNNING job in the same database IS reaped (control,
  // proving the call was live), while the terminal cancelled row is outside its target set and never resurrected.
  const staleId = await S.createQueryJob(db, A, { query: 'find stale buyers', icp: '{"x":1}', runBudget: null }, T0)
  await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1, claimed_at = 1 WHERE id = ?", [staleId])
  await S.reapStaleJobs(db, T0 + 100000)
  const staleAfter = (await db.get<{ status: string }>('SELECT status FROM scan_jobs WHERE id = ?', [staleId]))!
  assert.notEqual(staleAfter.status, 'running', 'control: the reaper was live - the genuinely stale running job was reaped')
  const after = (await db.get<{ status: string; attempts: number }>('SELECT status, attempts FROM scan_jobs WHERE id = ?', [id]))!
  assert.deepEqual(after, { status: 'failed', attempts: 1 }, 'the reaper never resurrects a cancelled job')
})

bothEngines('stale reaper: a running job past the timeout goes back to pending, or fails after the last attempt', async ({ db }) => {
  const now = T0 + 10_000
  const retry = await S.createJob(db, A, { business_name: 'R', industry: 'i', location: 'l' }, null, T0)
  const last = await S.createJob(db, B, { business_name: 'L', industry: 'i', location: 'l' }, null, T0)
  const fresh = await S.createJob(db, A, { business_name: 'F', industry: 'i', location: 'l' }, null, T0)
  await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1, claimed_at = ? WHERE id = ?", [now - Legacy.STALE_RUNNING_S - 1, retry])
  await db.run("UPDATE scan_jobs SET status = 'running', attempts = ?, claimed_at = ? WHERE id = ?", [Legacy.MAX_ATTEMPTS, now - Legacy.STALE_RUNNING_S - 1, last])
  await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1, claimed_at = ? WHERE id = ?", [now - 5, fresh])
  assert.equal(await S.reapStaleJobs(db, now), 2)
  assert.equal((await S.getJob(db, A, retry))!.status, 'pending')
  const l = (await S.getJob(db, B, last))!
  assert.deepEqual([l.status, l.error, Number(l.finished_at)], ['failed', 'timeout', now])
  assert.equal((await S.getJob(db, A, fresh))!.status, 'running')
})

// The functions the app still calls (store.ts, sync) and the Db versions return the same rows on the same database.
test('[sqlite] parity with store.ts on the same rows', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  const db = sqliteDb(raw)
  const a = await fixture(db, A, 'a'); await fixture(db, B, 'b')
  const norm = (v: unknown) => JSON.parse(JSON.stringify(v))
  const legacyJob = Legacy.getJob(raw, A, a.done)
  assert.deepEqual(norm(await S.getJob(db, A, a.done)), norm(legacyJob))
  for (const hidden of [false, true]) assert.deepEqual(norm(await S.listLeads(db, A, a.done, 200, hidden)), norm(Legacy.listLeads(raw, A, a.done, 200, hidden)))
  // the parity covers the page-timing columns main added: both stores return them, with the same values
  const legacyRow = (Legacy.listLeads(raw, A, a.done) as Record<string, unknown>[])[0]
  assert.ok('published_at' in legacyRow && 'timing_note' in legacyRow && legacyRow.published_at === '2026-09-30')
  const legacyExport = (Legacy.exportLeads(raw, A) as Record<string, unknown>[])[0]
  assert.ok('published_at' in legacyExport && 'timing_note' in legacyExport)
  assert.equal(await S.countHiddenLeads(db, A, a.done), Legacy.countHiddenLeads(raw, A, a.done))
  assert.deepEqual(norm(await S.listJobs(db, A)), norm(Legacy.listJobs(raw, A)))
  assert.equal(await S.latestJobId(db, A), Legacy.latestJobId(raw, A))
  assert.deepEqual(norm(await S.latestQueryJob(db, A)), norm(Legacy.latestQueryJob(raw, A)))
  for (const [job, fx] of [[undefined, false], [a.done, true]] as const) assert.deepEqual(norm(await S.exportLeads(db, A, job, 5000, fx)), norm(Legacy.exportLeads(raw, A, job, 5000, fx)))
  assert.equal(await S.countActiveJobs(db, A), Legacy.countActiveJobs(raw, A))
  await db.close()
})

// ---- step 2 (storage half): finishJob / failOrRequeue ----
const L = (key: string, o: Partial<S.LeadRow> = {}): S.LeadRow => ({ name: 'Pat', company: `Co ${key}`, contact: null, signal: 'Hiring', source_url: `https://e.example/${key}`, score: 70,
  evidence_excerpt: 'quote', event_date: '2026-10-01', date_status: 'verified', retrieved_at: T0, confidence: 80, dedup_key: key, fit: 4, ...o })
async function claimed(db: Db, attempts = 1) {
  const id = await S.createJob(db, A, { business_name: 'Biz', industry: 'software', location: 'Toronto' }, null, T0)
  await db.run("UPDATE scan_jobs SET status = 'running', attempts = ?, claimed_at = ? WHERE id = ?", [attempts, T0, id])
  return { id, attempts }
}

bothEngines('finishJob: the attempt that holds the job writes its leads, review rows and counts in one transaction; duplicates are skipped', async ({ db }) => {
  const job = await claimed(db)
  const r = await S.finishJob(db, job, {
    status: 'done', error: null, now: T0 + 60, candidates: 9, dropped: { stale: 2, no_quote: 1 },
    leads: [L('k1', { published_at: '2026-10-02', timing_note: 'published 2026-10-02' }), L('k2', { fit: 2 }), L('k1')], // the second k1 is a duplicate of the first
    review: [{ name: '', company: 'Rev Co', signal: 'Maybe', source_url: 'https://r.example/1', score: 40, evidence_excerpt: null, event_date: null, dedup_key: 'review:k3', review_reason: 'undated', published_at: '2025-03-01', timing_note: 'the quote names 2025; the event is older than the window' }],
  })
  assert.deepEqual(r, { owned: true, inserted: ['k1|https://e.example/k1', 'k2|https://e.example/k2', 'review:k3|https://r.example/1'] })
  const j = (await S.getJob(db, A, job.id))!
  assert.deepEqual([j.status, j.claimed_at, Number(j.finished_at), Number(j.candidates), Number(j.verified), Number(j.needs_review), Number(j.dropped), JSON.parse(j.drop_reasons!)],
    ['done', null, T0 + 60, 9, 3, 1, 3, { stale: 2, no_quote: 1 }])
  assert.equal(Number(j.lead_count), 3)
  const rev = await db.get<{ date_status: string; review_reason: string; published_at: string; timing_note: string }>("SELECT date_status, review_reason, published_at, timing_note FROM leads WHERE dedup_key = 'review:k3'")
  assert.deepEqual(rev, { date_status: 'undated', review_reason: 'undated', published_at: '2025-03-01', timing_note: 'the quote names 2025; the event is older than the window' })
  const k1 = await db.get<{ published_at: string; timing_note: string }>("SELECT published_at, timing_note FROM leads WHERE dedup_key = 'k1'")
  assert.deepEqual(k1, { published_at: '2026-10-02', timing_note: 'published 2026-10-02' })
  const k2 = await db.get<{ published_at: string | null; timing_note: string | null }>("SELECT published_at, timing_note FROM leads WHERE dedup_key = 'k2'")
  assert.deepEqual(k2, { published_at: null, timing_note: null })
})

bothEngines('finishJob: an attempt that no longer holds the job (re-claimed, cancelled, finished) writes nothing', async ({ db }) => {
  const job = await claimed(db, 2)
  assert.deepEqual(await S.finishJob(db, { id: job.id, attempts: 1 }, { status: 'done', error: null, leads: [L('late')] }), { owned: false })
  assert.deepEqual(await S.cancelJob(db, A, job.id, T0 + 5), { ok: true, was_running: true })
  assert.deepEqual(await S.finishJob(db, job, { status: 'done', error: null, leads: [L('late')] }), { owned: false })
  const j = (await S.getJob(db, A, job.id))!
  assert.deepEqual([j.status, j.error, Number(j.lead_count)], ['failed', 'cancelled', 0])
})

bothEngines('finishJob: an invalid row fails the whole attempt on both engines; nothing is half-written and the job stays running', async ({ db }) => {
  const job = await claimed(db)
  await assert.rejects(S.finishJob(db, job, { status: 'done', error: null, leads: [L('ok'), L('bad', { source_url: 'ftp://x.example/1' })] }))
  const j = (await S.getJob(db, A, job.id))!
  assert.deepEqual([j.status, Number(j.lead_count)], ['running', 0])
})

bothEngines('failOrRequeue: retryable errors requeue until the last attempt, then fail; non-retryable fails at once; stale writes nothing', async ({ db }) => {
  const a = await claimed(db, 1)
  assert.equal(await S.failOrRequeue(db, a, 'provider_down', { retryable: true, now: T0 + 1 }), 'retry')
  const ja = (await S.getJob(db, A, a.id))!
  assert.deepEqual([ja.status, ja.error, ja.claimed_at, ja.finished_at, Number(ja.attempts)], ['pending', 'provider_down', null, null, 1])
  const b = await claimed(db, Legacy.MAX_ATTEMPTS)
  assert.equal(await S.failOrRequeue(db, b, 'provider_down', { retryable: true, now: T0 + 2 }), 'failed')
  const c = await claimed(db, 1)
  assert.equal(await S.failOrRequeue(db, c, 'key_rejected', { retryable: false, now: T0 + 3 }), 'failed')
  assert.deepEqual([(await S.getJob(db, A, c.id))!.status, (await S.getJob(db, A, c.id))!.error], ['failed', 'key_rejected'])
  assert.equal(await S.failOrRequeue(db, { id: c.id, attempts: 1 }, 'late', { retryable: true }), 'stale')
  assert.equal((await S.getJob(db, A, c.id))!.error, 'key_rejected')
})

bothEngines("stale reaper: ANY attempt's reserved call ends the job accounting_uncertain; a pending row with one ends the same (never re-billed)", async ({ db }) => {
  const now = T0 + 10_000
  const earlier = await S.createJob(db, A, { business_name: 'E', industry: 'i', location: 'l' }, null, T0)
  const pend = await S.createJob(db, A, { business_name: 'P', industry: 'i', location: 'l' }, null, T0)
  const clean = await S.createJob(db, A, { business_name: 'C', industry: 'i', location: 'l' }, null, T0)
  await db.run("UPDATE scan_jobs SET status = 'running', attempts = 2, claimed_at = ? WHERE id = ?", [now - Legacy.STALE_RUNNING_S - 1, earlier])
  // attempt 1 < the job's current attempt 2: the maybe-billed EARLIER attempt (mutation: restoring c.attempt = scan_jobs.attempts re-queues this to pending - red)
  await db.run("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, status, created_at) VALUES ('cE', ?, ?, 1, 'llm.anthropic', 0.05, 'reserved', ?)", [A, earlier, now - 5000])
  // pending + reserved: the pre-#594 shape (the old reaper reset to pending regardless of reservations)
  await db.run("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, status, created_at) VALUES ('cP', ?, ?, 1, 'llm.anthropic', 0.05, 'reserved', ?)", [A, pend, now - 5000])
  await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1, claimed_at = ? WHERE id = ?", [now - Legacy.STALE_RUNNING_S - 1, clean])
  await S.reapStaleJobs(db, now)
  const e = (await S.getJob(db, A, earlier))!
  assert.deepEqual([e.status, e.error, Number(e.attempts)], ['failed', 'accounting_uncertain', 2])
  const pj = (await S.getJob(db, A, pend))!
  assert.deepEqual([pj.status, pj.error, Number(pj.attempts)], ['failed', 'accounting_uncertain', 0], 'pending+reserved ends closed: the park never bumps the attempt (0 = the seeded value), so no executor ever runs')
  assert.equal((await S.getJob(db, A, clean))!.status, 'pending', 'a stale job with NO reserved call is still retried')
})
