// #349 preservation under the composed change (synthetic, no network). The offer journey adds no migration, so this proves
// that on both stores an existing workspace keeps its data, password material and encrypted AI key across a migration
// rerun, that every read path of the change writes nothing, and that resolving one play's offer changes only that play's
// offer columns. Rollback is code-only (no schema change): the schema is byte-identical before and after the rerun.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { sqliteDb, pgDb, type Db } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { createQueryJob } from '../lib/scan/store-db.ts'
import { readPlayOffer, setPlayOffer } from '../lib/scan/play-offer.ts'
import { writeKey, readTenantKey } from '../lib/llm/key-store.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'

const DENTAL = 'We sell appointment booking and reminder software to independent dental practices in New York City.'
const SELLER = `${DENTAL} - https://seller.example`
const TABLES = ['users', 'sessions', 'tenant_llm_keys', 'scan_jobs']
const A = 'a'.repeat(32), B = 'b'.repeat(32)
const API_KEY = 'sk-ant-synthetic-' + 'A'.repeat(32)

async function snapshot(db: Db) {
  const out: Record<string, unknown[]> = {}
  for (const t of TABLES) out[t] = await db.all(`SELECT * FROM ${t} ORDER BY 1`)
  return JSON.stringify(out)
}

async function scenario(db: Db, rerun: () => Promise<string>, master: Buffer) {
  for (const [id, sells] of [[A, DENTAL], [B, 'Bookkeeping for agencies']] as const)
    await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt, sells) VALUES (?, ?, 'n', 'Acme', ?, ?, ?)", [id, `${id.slice(0, 4)}@example.test`, `scrypt$${id}$hash`, `salt-${id}`, sells])
  await db.run('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)', ['s'.repeat(64), A, 2_000_000_000])
  await writeKey(db, A, 'anthropic', API_KEY, master)
  const dental = await createQueryJob(db, A, { query: 'Independent dental practices in New York City hiring a front-desk coordinator. We sell appointment booking and reminder software.', icp: null, seller: SELLER })
  const london = await createQueryJob(db, A, { query: 'Find London SaaS startups hiring their first sales rep. We sell CRM setup and outbound consulting.', icp: null, seller: SELLER, offer: 'CRM setup and outbound consulting' })
  const legacy = await createQueryJob(db, A, { query: 'Find London SaaS startups hiring their first sales rep. We sell CRM setup and outbound consulting.', icp: null, seller: SELLER })
  const withdrawn = await createQueryJob(db, A, { query: 'Find Manchester agencies hiring. We no longer sell appointment booking and reminder software.', icp: null, seller: SELLER })

  // 1. a migration rerun keeps every row and the schema byte-identical; the key still decrypts with the same master
  const before = await snapshot(db), schemaBefore = await rerun()
  assert.equal(await rerun(), schemaBefore, 'schema unchanged by a second rerun')
  assert.equal(await snapshot(db), before, 'rows, password material, sessions and the sealed key are unchanged')
  assert.deepEqual(await readTenantKey(db, A, 'anthropic', master), { key: API_KEY, unreadable: false })

  // 2. every read of the change writes nothing
  assert.deepEqual(await readPlayOffer(db, A, dental), { offer: DENTAL, source: 'recorded', conflict: null })
  assert.deepEqual(await readPlayOffer(db, A, london), { offer: 'CRM setup and outbound consulting', source: 'play', conflict: null })
  assert.equal((await readPlayOffer(db, A, legacy))!.source, 'conflict')
  const w = await readPlayOffer(db, A, withdrawn)
  assert.equal(w!.source, 'conflict'); assert.equal(w!.conflict!.stated, null); assert.match(w!.conflict!.withdrawn!, /appointment booking/)
  assert.equal(await readPlayOffer(db, B, london), null, 'another workspace reads nothing')
  assert.equal(await snapshot(db), before, 'reads wrote nothing')

  // 3. resolving the withdrawal play changes only its offer columns; another workspace cannot
  assert.equal(await setPlayOffer(db, B, withdrawn, 'Bookkeeping for agencies'), false)
  assert.equal(await snapshot(db), before, 'a cross-tenant write changed nothing')
  assert.equal(await setPlayOffer(db, A, withdrawn, 'Bookkeeping for agencies'), true)
  const a = JSON.parse(before) as Record<string, Record<string, unknown>[]>, b = JSON.parse(await snapshot(db)) as typeof a
  for (const t of TABLES.filter(t => t !== 'scan_jobs')) assert.deepEqual(b[t], a[t], t)
  for (const [i, row] of b.scan_jobs.entries()) {
    const was = a.scan_jobs[i]
    if (row.id !== withdrawn) { assert.deepEqual(row, was, `play ${String(row.id)} unchanged`); continue }
    const { offer, offer_set_at, ...rest } = row, { offer: o0, offer_set_at: t0, ...rest0 } = was
    assert.deepEqual(rest, rest0, 'only the offer columns of the chosen play move')
    assert.deepEqual([o0, t0], [null, null]); assert.equal(offer, 'Bookkeeping for agencies'); assert.ok(offer_set_at)
  }
  // 4. a rerun after the choice keeps it
  const chosen = await snapshot(db); await rerun()
  assert.equal(await snapshot(db), chosen)
  assert.equal((await readPlayOffer(db, A, withdrawn))!.offer, 'Bookkeeping for agencies')
}

test('#349 [sqlite] data, passwords and sealed keys survive a migration rerun; reads write nothing; a choice moves one play only', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  const db = sqliteDb(raw)
  try {
    await scenario(db, async () => { migrateAllSqlite(raw); return JSON.stringify(raw.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all()) }, randomBytes(32))
  } finally { await db.close() }
})

test('#349 [pg] data, passwords and sealed keys survive a migration rerun; reads write nothing; a choice moves one play only', { skip: pgSkip }, async () => {
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema })
  try {
    await runPgMigrations(db.pool)
    await scenario(db, async () => {
      await runPgMigrations(db.pool)
      return JSON.stringify(await db.all("SELECT table_name, column_name, data_type, column_default, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY 1, 2"))
    }, randomBytes(32))
  } finally { await db.close(); await s.drop() }
})
