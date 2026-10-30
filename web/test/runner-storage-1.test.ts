// The scan runner's storage port, slice 1 (docs/PLATFORM.md "Runner storage port"): the non-yield modules the runner
// writes through, on the Db layer. Each twin must do exactly what the sync function the runner calls today does: the
// same scenario runs through the sync function on SQLite, the twin on SQLite and the twin on Postgres, and the results
// and the rows left behind must be identical. Tenant B's data is in every store and must never be read or changed.
// Stubbed worker only; nothing leaves the process.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { sqliteDb, pgDb, type Db } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'
import { saveKey, readKey, readTenantKey } from '../lib/llm/key-store.ts'
import { markWatchLeads, writeWatchLeads } from '../lib/watch.ts'
import { collectCompetitorComplaints, gatherCompetitorComplaints, badgeComplaintLeads, writeComplaintBadges } from '../lib/signals/competitor-reddit.ts'
import { saveCredential } from '../lib/connectors/store.ts'
import { acceptConsent } from '../lib/advanced/index.ts'

const A = 'a'.repeat(32), B = 'b'.repeat(32)
const master = randomBytes(32)
const T = 1_790_000_000
type Impl = 'sync' | 'async'

// One store per run. The fixture is written with the raw handle on SQLite (as the app's other modules write it today)
// and with plain SQL on both, so only the function under test differs between runs.
async function store(engine: 'sqlite' | 'pg'): Promise<{ db: Db; raw?: Database.Database; done: () => Promise<void> }> {
  if (engine === 'sqlite') {
    const raw = new Database(':memory:'); migrateAllSqlite(raw)
    const db = sqliteDb(raw)
    return { db, raw, done: async () => { raw.close() } }
  }
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 2 })
  await runPgMigrations(db.pool)
  return { db, done: async () => { await db.close(); await s.drop() } }
}
const runs = (): { engine: 'sqlite' | 'pg'; impl: Impl }[] => [{ engine: 'sqlite', impl: 'sync' }, { engine: 'sqlite', impl: 'async' }, ...(PG_URL ? [{ engine: 'pg' as const, impl: 'async' as const }] : [])]
async function scanFixture(db: Db) {
  for (const [job, user] of [['ja'.repeat(12), A], ['jb'.repeat(12), B]]) {
    await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, created_at) VALUES (?, ?, 'Co', 'dental', 'Toronto', ?)", [job, user, T])
    await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1 WHERE id = ?", [job])
  }
  const lead = (id: string, job: string, company: string, domain: string | null, url: string, signals: string | null = null) =>
    db.run("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, score, signals, created_at) VALUES (?, ?, 'Pat', ?, ?, 's', ?, 60, ?, ?)", [id, job, company, domain, url, signals, T])
  return { JA: 'ja'.repeat(12), JB: 'jb'.repeat(12), lead }
}

test('keys: the twin reads the tenant\'s key exactly as readKey does, never another tenant\'s, and reports an unreadable one', async () => {
  const out: unknown[] = []
  for (const { engine, impl } of runs()) {
    const s = await store(engine)
    try {
      const raw = s.raw ?? null
      if (raw) { saveKey(raw, A, 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master) }
      else {
        // the same ciphertext the sync writer stores, made on a scratch SQLite handle
        const scratch = new Database(':memory:'); migrateAllSqlite(scratch); saveKey(scratch, A, 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
        const row = scratch.prepare('SELECT * FROM tenant_llm_keys').get() as Record<string, unknown>; scratch.close()
        await s.db.run('INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', [row.tenant_id, row.vendor, row.ciphertext, row.last4, row.validated_at, row.created_at] as (string | number)[])
      }
      await s.db.run("INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at, created_at) VALUES (?, 'openai', 'not-a-ciphertext', '0000', 1, 1)", [B])
      const quiet = console.error; console.error = () => {}
      try {
        const read = (t: string, v: 'anthropic' | 'openai') => impl === 'sync' ? Promise.resolve(readKey(raw!, t, v, master)) : readTenantKey(s.db, t, v, master)
        out.push({ engine, impl, a: await read(A, 'anthropic'), aOpenai: await read(A, 'openai'), bAnthropic: await read(B, 'anthropic'), bBroken: await read(B, 'openai') })
      } finally { console.error = quiet }
    } finally { await s.done() }
  }
  const [first, ...rest] = out as Record<string, unknown>[]
  assert.deepEqual({ ...first, engine: 0, impl: 0 }, { engine: 0, impl: 0, a: { key: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', unreadable: false },
    aOpenai: { key: null, unreadable: false }, bAnthropic: { key: null, unreadable: false }, bBroken: { key: null, unreadable: true } })
  for (const r of rest) assert.deepEqual({ ...r, engine: 0, impl: 0 }, { ...first, engine: 0, impl: 0 }, `${r.engine}/${r.impl} differs`)
})

test('watch: new leads flagged and remembered once per company key, only for this run\'s job and this watch', async () => {
  const out: unknown[] = []
  for (const { engine, impl } of runs()) {
    const s = await store(engine)
    try {
      const { JA, JB, lead } = await scanFixture(s.db)
      for (const [w, u] of [['wA', A], ['wB', B]]) await s.db.run("INSERT INTO watches (id, user_id, query, icp, next_run_at, created_at) VALUES (?, ?, 'q', '{}', ?, ?)", [w, u, T, T])
      await s.db.run("INSERT INTO watch_seen (watch_id, seen_key) VALUES ('wA', 'seen.example')")
      await lead('l1', JA, 'Seen Co', 'Seen.example', 'https://seen.example/a')
      await lead('l2', JA, 'Acme Dental', null, 'https://acme.example/a')
      await lead('l3', JA, 'ACME dental!', null, 'https://acme.example/b') // same key as l2, both new this run
      await lead('l4', JA, '', null, 'https://x.example/') // no key: never new
      await lead('lb', JB, 'Acme Dental', null, 'https://acme.example/a') // tenant B's job
      const fresh = impl === 'sync' ? markWatchLeads(s.raw!, 'wA', JA) : await writeWatchLeads(s.db, 'wA', JA)
      out.push({ fresh, leads: await s.db.all('SELECT id, watch_new FROM leads ORDER BY id'), seen: await s.db.all('SELECT watch_id, seen_key FROM watch_seen ORDER BY watch_id, seen_key') })
      // a second run of the same job marks nothing new
      assert.equal(impl === 'sync' ? markWatchLeads(s.raw!, 'wA', JA) : await writeWatchLeads(s.db, 'wA', JA), 0)
    } finally { await s.done() }
  }
  assert.deepEqual(out[0], {
    fresh: 2,
    leads: [{ id: 'l1', watch_new: 0 }, { id: 'l2', watch_new: 1 }, { id: 'l3', watch_new: 1 }, { id: 'l4', watch_new: 0 }, { id: 'lb', watch_new: 0 }],
    seen: [{ watch_id: 'wA', seen_key: '' }, { watch_id: 'wA', seen_key: 'acmedental' }, { watch_id: 'wA', seen_key: 'seen.example' }],
  })
  for (const r of out.slice(1)) assert.deepEqual(r, out[0])
})

test('competitor complaints: the same searches, sessions, budget and audit rows; only this tenant\'s competitors, consent and session', async () => {
  const env = { ADVANCED_CONNECTORS: '1', ADVANCED_WORKER_URL: 'https://worker.invalid', ADVANCED_WORKER_TOKEN: 't', ADVANCED_MAX_PER_HOUR: '3' }
  const recent = new Date(Date.now() - 86400_000).toISOString().slice(0, 10)
  const now = Math.floor(Date.now() / 1000)
  const out: unknown[] = []
  for (const { engine, impl } of runs()) {
    const s = await store(engine)
    try {
      for (const [t, names] of [[A, ['Zed', 'Bee', 'Cee', 'Dee']], [B, ['Other']]] as const) {
        for (const [i, n] of names.entries()) await s.db.run('INSERT INTO tenant_competitors (tenant_id, name, position) VALUES (?, ?, ?)', [t, n, i])
      }
      if (s.raw) { acceptConsent(s.raw, A, 'advanced'); acceptConsent(s.raw, B, 'advanced'); saveCredential(s.raw, A, 'adv:reddit', 'session-of-A', master); saveCredential(s.raw, B, 'adv:reddit', 'session-of-B', master) }
      else {
        const scratch = new Database(':memory:'); migrateAllSqlite(scratch)
        acceptConsent(scratch, A, 'advanced'); acceptConsent(scratch, B, 'advanced'); saveCredential(scratch, A, 'adv:reddit', 'session-of-A', master); saveCredential(scratch, B, 'adv:reddit', 'session-of-B', master)
        for (const r of scratch.prepare('SELECT * FROM advanced_consent').all() as Record<string, unknown>[]) await s.db.run('INSERT INTO advanced_consent (tenant_id, scope, version, accepted_at) VALUES (?, ?, ?, ?)', [r.tenant_id, r.scope, r.version, r.accepted_at] as (string | number)[])
        for (const r of scratch.prepare('SELECT * FROM tenant_connectors').all() as Record<string, unknown>[]) await s.db.run('INSERT INTO tenant_connectors (tenant_id, connector, ciphertext, last4, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)', [r.tenant_id, r.connector, r.ciphertext, r.last4, r.enabled, r.created_at] as (string | number)[])
        scratch.close()
      }
      // one Reddit call already this hour for A (counts against its budget of 3), one from two hours ago, and B's
      for (const [id, t, at] of [['c1', A, now - 600], ['c2', A, now - 7200], ['c3', B, now - 60]] as const) {
        await s.db.run("INSERT INTO connector_audit (id, tenant_id, connector, lookup, status, results, created_at) VALUES (?, ?, 'adv:reddit', 'x', 'ok', 0, ?)", [id, t, at])
      }
      const calls: { query: string; session: string }[] = []
      const worker = async (r: { query: string; session: string }) => {
        calls.push({ query: r.query, session: r.session })
        if (r.query.startsWith('Bee')) return null // the worker failed for this one
        return [{ url: `https://reddit.example/${r.query.split(' ')[0]}`, title: 't', quote: 'q', date: recent, login_walled: false }, { url: 'https://reddit.example/old', title: 't', quote: 'q', date: '2020-01-01', login_walled: false }]
      }
      const deps = { worker: worker as never, master, env, now }
      const items = impl === 'sync' ? await collectCompetitorComplaints(s.raw!, A, 'job1', deps) : await gatherCompetitorComplaints(s.db, A, 'job1', deps)
      out.push({ items, calls, audit: await s.db.all("SELECT tenant_id, connector, scan_job_id, lookup, status, results FROM connector_audit WHERE connector = 'adv:reddit-competitor' ORDER BY insert_seq") })
    } finally { await s.done() }
  }
  const first = out[0] as { items: { complaint_of: string }[]; calls: { session: string }[]; audit: unknown[] }
  assert.deepEqual(first.items.map(i => i.complaint_of), ['Zed'], 'budget 3 - 1 recent call = 2 searches (Zed, Bee); Bee failed; old posts dropped')
  assert.deepEqual(first.calls.map(c => c.session), ['session-of-A', 'session-of-A'], 'only A\'s session is ever sent')
  assert.equal(first.audit.length, 2)
  for (const r of out.slice(1)) assert.deepEqual(r, out[0])
})

test('complaint badges: merged into this job\'s leads citing the post, once, never into another job\'s lead with the same URL', async () => {
  const out: unknown[] = []
  const complaints = [{ url: 'https://reddit.example/z', complaint_of: 'Zed' }, { url: 'https://reddit.example/z', complaint_of: 'Bee' }, { url: 'https://reddit.example/z', complaint_of: 'Zed' }, { url: 'https://reddit.example/none', complaint_of: 'Cee' }]
  for (const { engine, impl } of runs()) {
    const s = await store(engine)
    try {
      const { JA, JB, lead } = await scanFixture(s.db)
      await lead('l1', JA, 'Co1', null, 'https://reddit.example/z', JSON.stringify(['hiring']))
      await lead('l2', JA, 'Co2', null, 'https://reddit.example/z', 'not json')
      await lead('l3', JA, 'Co3', null, 'https://reddit.example/other')
      await lead('lb', JB, 'CoB', null, 'https://reddit.example/z', JSON.stringify(['b']))
      const n = impl === 'sync' ? badgeComplaintLeads(s.raw!, JA, complaints) : await writeComplaintBadges(s.db, JA, complaints)
      out.push({ n, leads: await s.db.all('SELECT id, signals FROM leads ORDER BY id') })
    } finally { await s.done() }
  }
  assert.deepEqual(out[0], { n: 4, leads: [
    { id: 'l1', signals: '["hiring","complained about Zed","complained about Bee"]' },
    { id: 'l2', signals: '["complained about Zed","complained about Bee"]' },
    { id: 'l3', signals: null },
    { id: 'lb', signals: '["b"]' },
  ] })
  for (const r of out.slice(1)) assert.deepEqual(r, out[0])
})

test('the Postgres runs are not skipped silently when a test Postgres is configured', { skip: pgSkip }, () => { assert.equal(runs().length, 3) })
