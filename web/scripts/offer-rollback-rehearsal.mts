// #349 rollback rehearsal for the offer journey (synthetic, loopback only; never a production database).
// Usage: node --experimental-strip-types scripts/offer-rollback-rehearsal.mts <path to a checkout of the rollback target's web/>
//        [DAZL_TEST_PG_URL=postgres://...@127.0.0.1/... for the Postgres half; it uses its own schema and drops it]
// This head adds no migration, so a rollback is the previous code over the same database. On SQLite and on Postgres:
//   1. forward: this head's migrations, then synthetic users (password hash and salt), a session, a sealed AI key, three
//      plays (dental, a chosen London CRM play, a contested one), a Memory positioning, and this head's offer choice;
//   2. rerun: this head's migrations again;
//   3. rollback: the target's migrations and reads (play offers, the tenant key with the same master);
//   4. forward again: this head's migrations and reads.
// After every step the whole snapshot (rows and schema) must equal the first one, and both versions must read the same
// key and the same per-play offers. Exit 1 on any difference.
import assert from 'node:assert/strict'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import pg from 'pg'

const here = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const target = path.resolve(process.argv[2] ?? '')
if (!process.argv[2]) { console.error('usage: offer-rollback-rehearsal.mts <rollback target web/>'); process.exit(2) }
const load = async (root: string) => ({
  client: await import(path.join(root, 'lib/db/client.ts')),
  sqlite: await import(path.join(root, 'lib/db/sqlite-migrations.ts')),
  pgm: await import(path.join(root, 'lib/db/migrate-pg.ts')),
  offer: await import(path.join(root, 'lib/scan/play-offer.ts')),
  keys: await import(path.join(root, 'lib/llm/key-store.ts')),
})
const head = await load(here), prev = await load(target)
const TABLES = ['users', 'sessions', 'tenant_llm_keys', 'scan_jobs', 'tenant_memory']
const DENTAL = 'We sell appointment booking and reminder software to independent dental practices in New York City.'
const SELLER = `${DENTAL} - https://seller.example`
const A = 'a'.repeat(32), KEY = 'sk-ant-synthetic-' + 'A'.repeat(32), master = randomBytes(32)

type Db = { run: (s: string, p?: unknown[]) => Promise<unknown>; all: (s: string, p?: unknown[]) => Promise<Record<string, unknown>[]>; kind: string }
async function snapshot(db: Db, schema: () => Promise<unknown>) {
  const rows: Record<string, unknown> = {}
  for (const t of TABLES) rows[t] = await db.all(`SELECT * FROM ${t} ORDER BY 1`)
  return JSON.stringify({ rows, schema: await schema() })
}
// What must survive a rollback: the key read and every offer stored on a play. How an unchosen play RESOLVES is code
// (the rollback target resolves with its own, older rules, which is the point of a rollback) and is reported, not hidden.
async function reads(m: Awaited<ReturnType<typeof load>>, db: Db, ids: string[]) {
  const offers = await Promise.all(ids.map(id => m.offer.readPlayOffer(db, A, id))) as { offer: string | null; source: string }[]
  return { stored: JSON.stringify({ key: await m.keys.readTenantKey(db, A, 'anthropic', master), chosen: offers.map(o => o.source === 'play' ? o.offer : null) }), resolved: offers.map(o => `${o.source}:${o.offer ?? '-'}`) }
}
async function seed(db: Db) {
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt, sells) VALUES (?, 'owner@example.test', 'n', 'Synthetic Co', 'scrypt$synthetic$hash', 'synthetic-salt', ?)", [A, DENTAL])
  await db.run('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)', ['s'.repeat(64), A, 2_000_000_000])
  await head.keys.writeKey(db, A, 'anthropic', KEY, master)
  await db.run("INSERT INTO tenant_memory (tenant_id, positioning, updated_at) VALUES (?, ?, 1)", [A, DENTAL]).catch(() => { /* older schema without Memory: skipped */ })
  const ids: string[] = []
  for (const [q, offer] of [['Independent dental practices in New York City hiring a front-desk coordinator. We sell appointment booking and reminder software.', null],
    ['Find London SaaS startups hiring their first sales rep. We sell CRM setup and outbound consulting.', 'CRM setup and outbound consulting'],
    ['Find Manchester agencies hiring. We no longer sell appointment booking and reminder software.', null]] as const) {
    const id = randomBytes(12).toString('hex'); ids.push(id)
    await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, seller, offer, offer_set_at) VALUES (?, ?, 'x', '(from request)', '-', ?, ?, ?, ?)", [id, A, q, SELLER, offer, offer ? 1 : null])
  }
  // this head's choice on the contested play
  assert.equal(await head.offer.setPlayOffer(db, A, ids[2], 'Bookkeeping for agencies', 2), true)
  return ids
}
async function rehearse(name: string, db: Db, migrate: { head: () => Promise<void>; prev: () => Promise<void> }, schema: () => Promise<unknown>) {
  await migrate.head()
  const ids = await seed(db)
  const s0 = await snapshot(db, schema), r0 = await reads(head, db, ids)
  assert.match(r0.stored, new RegExp(KEY)); assert.match(r0.stored, /Bookkeeping for agencies/); assert.match(r0.stored, /CRM setup and outbound consulting/)
  await migrate.head(); assert.equal(await snapshot(db, schema), s0, `${name}: rerun changed data or schema`)
  await migrate.prev(); assert.equal(await snapshot(db, schema), s0, `${name}: rollback migrations changed data or schema`)
  const rp = await reads(prev, db, ids)
  assert.equal(rp.stored, r0.stored, `${name}: the rollback target reads a different key or stored offer`)
  const changed = r0.resolved.map((r, i) => r === rp.resolved[i] ? null : `play ${i + 1}: this head ${r} | rollback target ${rp.resolved[i]}`).filter(Boolean)
  await migrate.head(); assert.equal(await snapshot(db, schema), s0, `${name}: forward again changed data or schema`)
  const r2 = await reads(head, db, ids)
  assert.equal(r2.stored, r0.stored, `${name}: forward again reads a different key or stored offer`); assert.deepEqual(r2.resolved, r0.resolved)
  for (const c of changed) console.log(`${name}: resolution differs under the rollback target's code (no data change): ${c}`)
  console.log(`${name}: forward, rerun, rollback to the target and forward again keep every row, the schema, the password material, the sealed key read and every play offer (${ids.length} plays)`)
}

const dir = mkdtempSync(path.join(tmpdir(), 'dazl-rollback-'))
try {
  const raw = new Database(path.join(dir, 'app.db'))
  const db = head.client.sqliteDb(raw) as Db
  await rehearse('sqlite', db, { head: async () => head.sqlite.migrateAllSqlite(raw), prev: async () => prev.sqlite.migrateAllSqlite(raw) },
    async () => raw.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all())
  raw.close()
} finally { rmSync(dir, { recursive: true, force: true }) }

const url = process.env.DAZL_TEST_PG_URL
if (!url) { console.log('postgres: NOT RUN (DAZL_TEST_PG_URL not set)'); process.exit(process.env.DAZL_REQUIRE_PG === '1' ? 1 : 0) }
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(url).hostname)) throw new Error('loopback Postgres only')
const schemaName = 't_rb_' + randomBytes(5).toString('hex')
const admin = new pg.Client({ connectionString: url }); await admin.connect(); await admin.query(`CREATE SCHEMA ${schemaName}`); await admin.end()
const pdb = head.client.pgDb({ connectionString: url, searchPath: schemaName, max: 1 })
try {
  await rehearse('postgres', pdb as Db, { head: () => head.pgm.runPgMigrations(pdb.pool), prev: () => prev.pgm.runPgMigrations(pdb.pool) },
    () => pdb.all("SELECT table_name, column_name, data_type, column_default, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY 1, 2"))
} finally {
  await pdb.close()
  const c = new pg.Client({ connectionString: url }); await c.connect(); await c.query(`DROP SCHEMA ${schemaName} CASCADE`); await c.end()
}
