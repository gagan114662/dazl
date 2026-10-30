// #356: shared limits during a store outage (lib/rate-limit.ts). Auth, trial and shared-cost kinds FAIL CLOSED: a fresh
// process, a restart or an instance that cannot reach the shared store gets no allowance of its own, so the aggregate
// cost-bearing allowance never multiplies across instances. Only the listed low-risk kinds keep a per-process limit.
// Real separate processes over one SQLite file and one Postgres schema; every fetch counted (zero provider calls).
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { DEGRADED, degradedPolicy } from '../lib/rate-limit.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { pgDb } from '../lib/db/client.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'

const run = promisify(execFile)
const web = path.join(import.meta.dirname, '..')

test('every rateLimit call site\'s kind has an explicit degraded policy; unknown kinds fail closed', () => {
  const files: string[] = []
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) files.push(p) } }
  walk(path.join(web, 'app')); walk(path.join(web, 'lib'))
  const kinds = new Set<string>()
  for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/rateLimit\(\s*`([a-z:-]+?):\$\{/g)) kinds.add(m[1])
  assert.ok(kinds.size >= 45, `found ${kinds.size} call-site kinds`)
  for (const k of kinds) assert.ok(k in DEGRADED, `rateLimit kind '${k}' has no degraded policy in lib/rate-limit.ts`)
  for (const k of ['signin-ip', 'signin-acct', 'signup', 'google', 'google-cb', 'scan', 'qualify', 'polish', 'find-contact', 'settings:enrichment', 'checkout', 'crm', 'watch'])
    assert.equal(DEGRADED[k], 'closed', k)
  assert.equal(degradedPolicy('signin-ip:2001:db8::1'), 'closed', 'an IPv6 address after the kind')
  assert.equal(degradedPolicy('settings:enrichment:u1'), 'closed')
  assert.equal(degradedPolicy('unsub:10.0.0.1'), 'local')
  assert.equal(degradedPolicy('send:u1'), 'local', 'transactional sends keep their own budgets')
  assert.equal(degradedPolicy('something-new:u1'), 'closed')
  assert.equal(degradedPolicy('scan'), 'closed', 'no kind separator')
})

type Out = { allowed: number; unavailable: number; fetches: number }
type Store = Record<string, string>
const instance = async (store: Store, key: string, limit: number, calls: number, extra: Store = {}): Promise<Out> => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...store, ...extra, CHILD_BUCKET: key, CHILD_LIMIT: String(limit), CHILD_CALLS: String(calls) }
  delete env.NODE_TEST_CONTEXT
  const { stdout } = await run(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', './test/helpers/rate-limit-instance.mts'], { cwd: web, env, timeout: 120_000 })
  return JSON.parse(stdout) as Out
}
const together = (n: number) => String(Date.now() + n) // a common start line for instances launched together

async function scenarios(store: Store) {
  const healthy = store, broken = { ...store, CHILD_BROKEN: '1' }
  const all: Out[] = []
  const go = async (s: Store, key: string, limit: number, calls: number, extra?: Store) => { const o = await instance(s, key, limit, calls, extra); all.push(o); return o }

  // 1. two fresh instances, both cut off from the store: a closed kind allows nothing in total (not 2 x limit)
  const start = together(1500)
  const [a, b] = await Promise.all([go(broken, 'scan:t1', 5, 10, { CHILD_START_AT: start }), go(broken, 'scan:t1', 5, 10, { CHILD_START_AT: start })])
  assert.deepEqual([a.allowed, b.allowed, a.unavailable, b.unavailable], [0, 0, 10, 10])
  // ...while a deliberately low-risk kind keeps each instance's own limit (explicit, documented degraded behaviour)
  const [c, d] = await Promise.all([go(broken, 'profile:t1', 5, 10), go(broken, 'profile:t1', 5, 10)])
  assert.deepEqual([c.allowed, d.allowed, c.unavailable, d.unavailable], [5, 5, 0, 0])

  // 2. restart: the allowance is spent while healthy; a restarted (fresh) instance gets none, healthy or cut off
  assert.equal((await go(healthy, 'signin-acct:pat@example.test', 5, 8)).allowed, 5)
  assert.equal((await go(healthy, 'signin-acct:pat@example.test', 5, 8)).allowed, 0)
  assert.equal((await go(broken, 'signin-acct:pat@example.test', 5, 8)).allowed, 0)

  // 3. partial outage under concurrency: one instance reaches the store, the other cannot; together they get exactly
  //    the shared limit, all of it through the healthy instance
  const start2 = together(1500)
  const [h, x] = await Promise.all([go(healthy, 'qualify:t2', 10, 20, { CHILD_START_AT: start2 }), go(broken, 'qualify:t2', 10, 20, { CHILD_START_AT: start2 })])
  assert.deepEqual([h.allowed, x.allowed, x.unavailable], [10, 0, 20])

  // 4. recovery: the cut-off instance comes back; the window's allowance is already used, so it gets nothing more...
  assert.equal((await go(healthy, 'qualify:t2', 10, 5)).allowed, 0)
  // ...and calls refused during an outage were never counted against the shared allowance
  assert.equal((await go(broken, 'polish:t3', 3, 4)).allowed, 0)
  assert.equal((await go(healthy, 'polish:t3', 3, 4)).allowed, 3)

  // two healthy fresh instances racing on one closed key: still exactly the limit in total
  const start3 = together(1500)
  const [p, q] = await Promise.all([go(healthy, 'find-contact:t4', 7, 15, { CHILD_START_AT: start3 }), go(healthy, 'find-contact:t4', 7, 15, { CHILD_START_AT: start3 })])
  assert.equal(p.allowed + q.allowed, 7)

  assert.equal(all.reduce((n, o) => n + o.fetches, 0), 0, 'zero provider calls')
}

test('[sqlite] fresh instances, restart, partial outage, recovery and concurrency: closed kinds never multiply', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dazl-rl-'))
  try {
    const file = path.join(dir, 'app.db')
    const raw = new Database(file); raw.pragma('journal_mode = WAL'); migrateAllSqlite(raw); raw.close()
    await scenarios({ CHILD_SQLITE: file })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('[pg] fresh instances, restart, partial outage, recovery and concurrency: closed kinds never multiply', { skip: pgSkip }, async () => {
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema })
  try {
    await runPgMigrations(db.pool)
    await scenarios({ CHILD_PG_SCHEMA: s.schema })
  } finally { await db.close(); await s.drop() }
})

test('API: sign-in, sign-up, Google sign-in and scans answer 503 limits_unavailable during a partial outage, then recover', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/health-route-loader.mjs', '--test', './test/helpers/limits-outage-route-runtime.mts'],
  { cwd: web, env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined, String(r.error))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 2\b/)
  assert.match(r.stdout, /LIMITS_OUTAGE_ROUTES_OK/)
})
