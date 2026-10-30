// Postgres port, batch 3 (#354 part 2): the scan status route (GET /api/scan/status), the most-polled read in the app,
// moved to the Db layer with its per-source reads (source runs, search stats, model usage, run report, first-5 leads).
// The real handler runs on SQLite and on Postgres from the same seed, two tenants; every response and the rows the
// stale-job reap leaves must be identical on both engines. On Postgres the raw SQLite handle is a trap (getScanDb()
// throws and getAuthDb() cannot open), so a read still on it fails the run. Synthetic data only; any fetch fails.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { setDb, sqliteDb, pgDb, type Db } from '../../lib/db/client.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { runPgMigrations } from '../../lib/db/migrate-pg.ts'
import { PG_URL, freshSchema } from './pg-test.ts'

process.env.DB_PATH = '/nonexistent-dazl-dir/app.db' // getAuthDb() cannot open: any raw access fails
const status = await import('../../app/api/scan/status/route.ts')
globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call: ${String(u)}`) }) as typeof fetch

const A = 'tenantA_fixture', B = 'tenantB_fixture'
const T = 1_790_000_000
const NOW = Math.floor(Date.now() / 1000)
const J = { done: 'a1'.repeat(12), first5: 'a2'.repeat(12), stale: 'a3'.repeat(12), staleLast: 'a4'.repeat(12), bare: 'a5'.repeat(12), other: 'b1'.repeat(12) }

async function seed(db: Db): Promise<void> {
  const run = (sql: string, p: (string | number | null)[] = []) => db.run(sql, p)
  for (const [id, email] of [[A, 'a@example.test'], [B, 'b@example.test']]) await run("INSERT INTO users (id, email, password_hash, salt, business_name, created_at) VALUES (?, ?, 'h', 's', 'Co', ?)", [id, email, T])
  const job = (id: string, user: string, budget: string | null = null) => run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, icp, icp_inferred, run_budget, created_at) VALUES (?, ?, 'Co', 'dental', 'Toronto', 'dental clinics hiring', ?, 1, ?, ?)", [id, user, JSON.stringify({ industry: 'dental' }), budget, T])
  await job(J.done, A); await job(J.first5, A, JSON.stringify({ first5: true })); await job(J.stale, A); await job(J.staleLast, A); await job(J.bare, A); await job(J.other, B)
  for (const id of Object.values(J)) await run("UPDATE scan_jobs SET status = 'running', attempts = 1, claimed_at = ? WHERE id = ?", [NOW, id])
  // Leads while running (the insert trigger), then the jobs finish or go stale.
  const lead = (id: string, jobId: string, company: string, fit: number | null, review: string | null, seq: number) =>
    run("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, fit, review_reason, published_at, created_at) VALUES (?, ?, 'Pat', ?, 'Hiring hygienists', 'https://news.example/a', 70, ?, ?, '2026-10-01', ?)", [id, jobId, company, fit, review, T + seq])
  await lead('c1'.repeat(12), J.done, 'First Dental', 4, null, 1)
  await lead('c2'.repeat(12), J.first5, 'Second Dental', 5, null, 2)
  await lead('c3'.repeat(12), J.first5, 'Third Dental', null, null, 3)
  await lead('c4'.repeat(12), J.first5, 'Held Dental', 4, 'quote_unconfirmed', 4)
  await lead('c5'.repeat(12), J.first5, 'Low Fit Dental', 1, null, 5)
  await lead('c6'.repeat(12), J.other, 'Other Tenant Dental', 4, null, 6)
  for (const id of [J.done, J.first5, J.other]) {
    await run("INSERT INTO scan_source_runs (job_id, attempt, collector, status, evidence_count, candidate_count, verified_count, review_count, inserted_count) VALUES (?, 1, 'news', 'ok', 4, 3, 2, 1, 2)", [id])
    await run("INSERT INTO scan_source_runs (job_id, attempt, collector, status, evidence_count, candidate_count, verified_count, review_count, inserted_count) VALUES (?, 1, 'jobs', 'failed', NULL, NULL, NULL, NULL, 0)", [id])
  }
  await run(`INSERT INTO scan_source_stats (job_id, attempt, collector, queries, query_source, searches_attempted, searches_ok, searches_failed, searches_not_attempted, hits_raw, hits_unique_urls, hits_complete, fetch_complete, per_query)
    VALUES (?, 1, 'news', ?, 'model', 3, 2, ?, '{}', 40, 31, 0, NULL, ?)`, [J.done, JSON.stringify(['dental clinics hiring toronto']), JSON.stringify({ timeout: 1 }), JSON.stringify([{ q: 'dental clinics hiring toronto', hits: 40 }])])
  for (const [seq, stage, inTok, outTok, outcome] of [[1, 'extract', 1200, 300, 'ok'], [2, 'verify', null, null, 'error'], [3, 'extract', 900, 250, 'ok']] as [number, string, number | null, number | null, string][]) {
    await run("INSERT INTO scan_model_calls (tenant_id, job_id, attempt, seq, stage, method, model_requested, model_served, input_tokens, output_tokens, outcome, max_tokens, prompt_chars, recorded_at) VALUES (?, ?, 1, ?, ?, 'messages', 'claude-sonnet-4-5', 'claude-sonnet-4-5', ?, ?, ?, 800, 5000, ?)", [A, J.done, seq, stage, inTok, outTok, outcome, T])
  }
  await run('INSERT INTO scan_run_report (job_id, attempt, report, created_at) VALUES (?, 1, ?, ?)', [J.done, JSON.stringify({ attempt: 1, extraction: { pages: 3, candidates: 2 }, resolution: { candidates: 2, resolved: 1, unresolved: 1, by_reason: { no_contact: 1 } } }), T])
  await run("UPDATE scan_jobs SET status = 'done', finished_at = ?, candidates = 3, verified = 2, needs_review = 1, dropped = 0, drop_reasons = '{}' WHERE id IN (?, ?, ?, ?)", [T + 10, J.done, J.first5, J.bare, J.other])
  // Stale: running and claimed long ago; one with attempts left (back to pending), one on its last attempt (failed).
  await run('UPDATE scan_jobs SET claimed_at = ? WHERE id IN (?, ?)', [NOW - 10 * 3600, J.stale, J.staleLast])
  await run('UPDATE scan_jobs SET attempts = 3 WHERE id = ?', [J.staleLast])
}

type Out = { name: string; status: number; body: unknown }
async function call(name: string, res: Response | Promise<Response>): Promise<Out> {
  const r = await res
  const text = await r.text()
  let body: unknown = text
  try { body = JSON.parse(text) } catch { /* not JSON */ }
  return { name, status: r.status, body }
}
const get = (job: string) => status.GET(new NextRequest(`https://app.dazl.test/api/scan/status?job_id=${job}&passive=1`))
// finished_at of a job the reap failed is the clock: compare as 'now'.
const norm = (v: unknown, k = ''): unknown => Array.isArray(v) ? v.map(x => norm(x, k)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([kk, x]) => [kk, norm(x, kk)])) : typeof v === 'number' && /_at$/.test(k) && v >= NOW - 5 ? 'now' : v

async function scenario(db: Db): Promise<{ out: Out[]; rows: unknown }> {
  const out: Out[] = []
  setUser({ id: A, business_name: 'Co' })
  for (const [n, j] of Object.entries(J)) out.push(await call(`A ${n}`, get(j)))
  out.push(await call('A malformed id', get('not-a-job')))
  setUser({ id: B, business_name: 'Co' })
  out.push(await call('B asks for A done', get(J.done)))
  out.push(await call('B asks for A first5', get(J.first5)))
  out.push(await call('B own', get(J.other)))
  const rows = await db.all('SELECT id, status, error, attempts, claimed_at, finished_at FROM scan_jobs ORDER BY id')
  return { out: norm(out) as Out[], rows: norm(rows) }
}

async function onSqlite() {
  const lite = new Database(':memory:')
  migrateAllSqlite(lite)
  setScanDb(lite)
  await seed(sqliteDb(lite))
  return scenario(sqliteDb(lite))
}
async function onPg() {
  const s = await freshSchema()
  const pg = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 3 })
  try {
    await runPgMigrations(pg.pool)
    setScanDb(null as unknown as Database.Database) // getScanDb() now throws 'test database unset'
    setDb(pg)
    await seed(pg)
    return await scenario(pg)
  } finally { await pg.close(); await s.drop() }
}

const by = (out: Out[], n: string) => out.find(o => o.name === n)!
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are read loosely and compared exactly
type Body = Record<string, any>

test('batch 3 on SQLite: the status route serves the owner\'s scan with every per-source read, and nothing of another tenant', async () => {
  const { out, rows } = await onSqlite()
  const o = (n: string) => by(out, n).body as Body
  const done = o('A done')
  assert.equal(by(out, 'A done').status, 200)
  assert.deepEqual(done.source_runs.map((r: Body) => [r.collector, r.status, r.inserted_count]), [['jobs', 'failed', 0], ['news', 'ok', 2]])
  assert.deepEqual(done.source_runs[0].evidence_count, null, 'not recorded stays null')
  assert.deepEqual(done.source_stats.map((r: Body) => [r.collector, r.queries, r.searches_failed]), [['news', ['dental clinics hiring toronto'], { timeout: 1 }]])
  assert.deepEqual([done.model_usage.recorded, done.model_usage.requests_recorded, done.model_usage.input_tokens, done.model_usage.tokens_complete, done.model_usage.errors], [true, 3, 2100, false, 1])
  assert.deepEqual(done.resolution, { candidates: 2, resolved: 1, unresolved: 1, by_reason: { no_contact: 1 } })
  assert.equal(done.lead_count, 1)
  assert.equal(done.first5, undefined, 'not a first-5 scan')
  const f5 = o('A first5')
  assert.deepEqual(f5.first5.leads.map((l: Body) => [l.company, l.fit_pct]), [['Second Dental', 100], ['Third Dental', null]], 'verified only, best fit first; held and low-fit leads out')
  const bare = o('A bare')
  assert.deepEqual([bare.source_stats, bare.model_usage.recorded, bare.run_report], [[], false, null], 'nothing recorded reads as not recorded, never zero')
  assert.deepEqual([o('A stale').status, o('A staleLast').status, o('A staleLast').error], ['pending', 'failed', 'timeout'], 'the poll reaps stale jobs')
  assert.equal(by(out, 'A malformed id').status, 404)
  for (const n of ['B asks for A done', 'B asks for A first5']) assert.deepEqual([by(out, n).status, by(out, n).body], [404, { error: 'Not found' }], n)
  assert.deepEqual(o('B own').source_runs.length, 2)
  assert.ok(!JSON.stringify(out.filter(x => x.name.startsWith('A '))).includes('Other Tenant Dental'))
  void rows
})

test('batch 3 on Postgres: the same responses and the same reaped rows as SQLite', { skip: PG_URL ? false : 'DAZL_TEST_PG_URL not set' }, async () => {
  const lite = await onSqlite()
  const pg = await onPg()
  assert.deepEqual(pg.out, lite.out)
  assert.deepEqual(pg.rows, lite.rows)
  console.log('BATCH3 ROUTES IDENTICAL')
})
