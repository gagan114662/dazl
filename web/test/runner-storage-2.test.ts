// The scan runner's storage port, slice 2: TinyFish's usage caps and the advanced connectors on the Db layer. Both
// take the Db layer or today's raw handle (DbLike). The caps are checked and recorded in one transaction, so calls made
// at the same time, in one process or from two instances on one Postgres, never pass a cap together. Tenant B's usage,
// consent, session and audit rows are in every store and must never count for or leak to tenant A. Stubbed fetch and
// worker only; nothing leaves the process.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { pgDb, sqliteDb, type Db } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { tfSearch, tfFetch, resetTinyfishState } from '../lib/search/tinyfish.ts'
import { collectAdvanced } from '../lib/advanced/index.ts'
import { saveCredential } from '../lib/connectors/store.ts'
import { acceptConsent } from '../lib/advanced/index.ts'
import { bothEngines } from './helpers/engines.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'

const A = 'a'.repeat(32), B = 'b'.repeat(32)
const master = randomBytes(32)
const env = (over: Record<string, string> = {}) => ({ TINYFISH_API_KEY: 'tf-test', TINYFISH_PER_MINUTE: '1000', ...over })
function stubFetch() {
  const calls: string[] = []
  const f = (async (u: string | URL, init?: RequestInit) => {
    calls.push(String(u))
    await new Promise(r => setTimeout(r, 5)) // a real call takes a while: concurrent callers overlap
    if ((init?.method ?? 'GET') === 'POST') return new Response(JSON.stringify({ results: JSON.parse(String(init!.body)).urls.map((url: string) => ({ url, title: 't', text: 'x'.repeat(60) })) }), { status: 200 })
    return new Response(JSON.stringify({ results: [{ url: 'https://e.example/a', title: 'A hit', snippet: 's', date: '2026-10-01' }] }), { status: 200 })
  }) as typeof fetch
  return { calls, f }
}
const usage = async (db: Db) => db.all('SELECT day, tenant_id, kind, n FROM tinyfish_usage ORDER BY tenant_id, kind')

bothEngines('TinyFish: ten searches at once under a tenant cap of 3 make exactly 3 calls; another tenant\'s use counts only toward the global cap', async ({ db }) => {
  resetTinyfishState()
  const now = 1_793_000_000
  await db.run("INSERT INTO tinyfish_usage (day, tenant_id, kind, n) VALUES (?, ?, 'search', 5)", [new Date(now * 1000).toISOString().slice(0, 10), B])
  const { calls, f } = stubFetch()
  const spent = { searches: 0 }
  const r = await Promise.all(Array.from({ length: 10 }, (_, i) => tfSearch(db, A, `q${i}`, {}, spent, { env: env({ TINYFISH_TENANT_DAILY: '3', TINYFISH_SEARCHES_PER_SCAN: '100' }), fetchImpl: f, now })))
  assert.equal(calls.length, 3, 'tenant B\'s 5 searches do not count against A\'s cap of 3')
  assert.deepEqual(r.map(x => x.ok ? 'ok' : x.reason).sort(), [...Array(3).fill('ok'), ...Array(7).fill('cap')].sort())
  assert.equal(spent.searches, 3)
  assert.deepEqual((await usage(db)).map(u => [(u as { tenant_id: string }).tenant_id, Number((u as { n: number }).n)]), [[A, 3], [B, 5]])
  // the global search cap counts every tenant: 3 (A) + 5 (B) = 8 reached, so A's next search is refused
  const g = await tfSearch(db, A, 'one more', {}, { searches: 0 }, { env: env({ TINYFISH_TENANT_DAILY: '100', TINYFISH_GLOBAL_SEARCH_DAILY: '8' }), fetchImpl: f, now })
  assert.deepEqual(g, { ok: false, reason: 'cap' })
  assert.equal(calls.length, 3)
})

bothEngines('TinyFish fetch: concurrent batches share the tenant room exactly; the room counts search and fetch use together', async ({ db }) => {
  resetTinyfishState()
  const now = 1_793_000_000
  const { calls, f } = stubFetch()
  const spent = { fetches: 0 }
  const urls = Array.from({ length: 6 }, (_, i) => `https://e.example/${i}`)
  // tenant daily 10 = 4 fetched URLs (two batches of 2 fit) + ... : 3 batches of 4 URLs at once, room 10
  const r = await Promise.all([0, 1, 2].map(() => tfFetch(db, A, urls.slice(0, 4), spent, { env: env({ TINYFISH_TENANT_DAILY: '10', TINYFISH_FETCHES_PER_SCAN: '100' }), fetchImpl: f, now })))
  const fetched = r.reduce((n, x) => n + (x.ok ? x.pages.length : 0), 0)
  assert.equal(fetched, 10, 'exactly the room: 4 + 4 + 2')
  assert.equal(spent.fetches, 10)
  assert.equal(calls.length, 3)
  assert.deepEqual((await usage(db)).map(u => Number((u as { n: number }).n)), [10])
})

test('[pg] TinyFish caps hold across two instances on one Postgres: 12 searches at once from two pools, tenant cap 5, exactly 5 calls', { skip: pgSkip }, async () => {
  resetTinyfishState()
  const s = await freshSchema()
  const one = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 6 })
  const two = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 6 })
  try {
    await runPgMigrations(one.pool)
    const { calls, f } = stubFetch()
    const now = 1_793_000_000
    // each instance has its own per-scan counter and process state, as two processes would
    const r = await Promise.all(Array.from({ length: 12 }, (_, i) => tfSearch(i % 2 ? one : two, A, `q${i}`, {}, { searches: 0 }, { env: env({ TINYFISH_TENANT_DAILY: '5' }), fetchImpl: f, now })))
    assert.equal(calls.length, 5)
    assert.equal(r.filter(x => x.ok).length, 5)
    assert.equal(Number((await one.get<{ n: number }>('SELECT SUM(n) AS n FROM tinyfish_usage'))!.n), 5)
  } finally { await one.close(); await two.close(); await s.drop() }
})

test('advanced connectors: the same gates, sessions, budget and audit rows from the raw handle and the Db layer on both engines; only this tenant\'s', async () => {
  const advEnv = { ADVANCED_CONNECTORS: '1', ADVANCED_WORKER_URL: 'https://worker.invalid', ADVANCED_WORKER_TOKEN: 't', ADVANCED_MAX_PER_HOUR: '3', X_VIA_SEARCH: '0' }
  const now = Math.floor(Date.now() / 1000)
  const outs: unknown[] = []
  const variants: { name: string; open: () => Promise<{ store: Db | Database.Database; db: Db; raw?: Database.Database; done: () => Promise<void> }> }[] = [
    { name: 'sqlite raw handle', open: async () => { const raw = new Database(':memory:'); migrateAllSqlite(raw); return { store: raw, db: sqliteDb(raw), raw, done: async () => raw.close() } } },
    { name: 'sqlite Db', open: async () => { const raw = new Database(':memory:'); migrateAllSqlite(raw); return { store: sqliteDb(raw), db: sqliteDb(raw), raw, done: async () => raw.close() } } },
    ...(PG_URL ? [{ name: 'pg Db', open: async () => { const s = await freshSchema(); const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 2 }); await runPgMigrations(db.pool); return { store: db, db, done: async () => { await db.close(); await s.drop() } } } }] : []),
  ]
  for (const v of variants) {
    const st = await v.open()
    try {
      // consent and sessions as the settings routes store them (made on a scratch SQLite handle, copied in)
      const scratch = new Database(':memory:'); migrateAllSqlite(scratch)
      acceptConsent(scratch, A, 'advanced'); acceptConsent(scratch, B, 'advanced')
      saveCredential(scratch, A, 'adv:reddit', 'reddit-of-A', master); saveCredential(scratch, B, 'adv:reddit', 'reddit-of-B', master); saveCredential(scratch, B, 'adv:x', 'x-of-B', master)
      for (const r of scratch.prepare('SELECT * FROM advanced_consent').all() as Record<string, string | number>[]) await st.db.run('INSERT INTO advanced_consent (tenant_id, scope, version, accepted_at) VALUES (?, ?, ?, ?)', [r.tenant_id, r.scope, r.version, r.accepted_at])
      for (const r of scratch.prepare('SELECT * FROM tenant_connectors').all() as Record<string, string | number>[]) await st.db.run('INSERT INTO tenant_connectors (tenant_id, connector, ciphertext, last4, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)', [r.tenant_id, r.connector, r.ciphertext, r.last4, r.enabled, r.created_at])
      scratch.close()
      // reddit: A made 2 calls in the last hour (budget 3), B made 5 (B's never count for A); x: A has 3 already (over)
      let k = 0
      for (const [t, c, n, ago] of [[A, 'adv:reddit', 2, 600], [A, 'adv:reddit', 4, 7200], [B, 'adv:reddit', 5, 60], [A, 'adv:x', 3, 60]] as const) {
        for (let i = 0; i < n; i++) await st.db.run("INSERT INTO connector_audit (id, tenant_id, connector, lookup, status, results, created_at) VALUES (?, ?, ?, 'x', 'ok', 0, ?)", [`seed${k++}`, t, c, now - ago])
      }
      const sessions: string[] = []
      const worker = async (r: { platform: string; session: string }) => { sessions.push(`${r.platform}:${r.session}`); return [{ url: `https://reddit.example/${r.platform}`, title: 't', quote: 'a quote long enough', date: '2026-10-01', login_walled: false }] }
      const items = await collectAdvanced(st.store, A, 'job1', ['reddit', 'x', 'reddit'], 'dentists hiring', { worker: worker as never, master, env: advEnv, now })
      outs.push({ items, sessions, audit: await st.db.all("SELECT tenant_id, connector, scan_job_id, lookup, status, results FROM connector_audit WHERE id NOT LIKE 'seed%' ORDER BY insert_seq") })
    } finally { await st.done() }
  }
  const first = outs[0] as { sessions: string[]; audit: { status: string }[] }
  assert.deepEqual(first.sessions, ['reddit:reddit-of-A'], 'reddit once (2 + 1 = the budget of 3), then rate limited; x over budget; never B\'s session')
  assert.deepEqual(first.audit.map(a => a.status), ['ok', 'rate_limited', 'rate_limited'])
  for (const [i, o] of outs.slice(1).entries()) assert.deepEqual(o, outs[0], `${variants[i + 1].name} differs`)
})
