import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { sqliteDb, pgDb, toPgPlaceholders, parseInt8 } from '../lib/db/client.ts'
import type { Db } from '../lib/db/client.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'

test('placeholders: ? becomes $n outside strings, identifiers and comments', () => {
  assert.equal(toPgPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?'), 'SELECT * FROM t WHERE a = $1 AND b = $2')
  assert.equal(toPgPlaceholders("SELECT '?', 'it''s ?', \"q?\" FROM t WHERE a = ? -- why?\n AND b = ? /* ? */"),
    "SELECT '?', 'it''s ?', \"q?\" FROM t WHERE a = $1 -- why?\n AND b = $2 /* ? */")
  assert.throws(() => toPgPlaceholders("SELECT 'open"), /unterminated/)
  assert.throws(() => toPgPlaceholders('SELECT j ?| array[?]'), /jsonb/)
})

test('int8 parser: safe integers become numbers, larger values fail loudly', () => {
  assert.equal(parseInt8('1800000000'), 1800000000)
  assert.throws(() => parseInt8('9007199254740993'), /unsafe integer/)
})

// One contract, run on both engines.
async function contract(db: Db) {
  await db.run('CREATE TABLE items (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, n INTEGER NOT NULL, note TEXT)')
  assert.deepEqual(await db.run('INSERT INTO items (id, tenant_id, n, note) VALUES (?, ?, ?, ?)', ['a', 't1', 1800000000, 'x?']), { changes: 1 })
  await db.run('INSERT INTO items (id, tenant_id, n, note) VALUES (?, ?, ?, ?)', ['b', 't1', 2, null])
  await db.run('INSERT INTO items (id, tenant_id, n, note) VALUES (?, ?, ?, ?)', ['c', 't2', 3, null])
  const a = await db.get<{ id: string; n: number; note: string }>('SELECT id, n, note FROM items WHERE id = ?', ['a'])
  assert.deepEqual(a, { id: 'a', n: 1800000000, note: 'x?' })
  assert.equal(typeof a!.n, 'number')
  assert.equal(await db.get('SELECT id FROM items WHERE id = ?', ['missing']), undefined)
  assert.deepEqual((await db.all<{ id: string }>("SELECT id FROM items WHERE tenant_id = ? AND id <> '?' ORDER BY id", ['t1'])).map(r => r.id), ['a', 'b'])
  // conditional update reports changes, the claim primitive every module relies on
  assert.deepEqual(await db.run('UPDATE items SET n = n + 1 WHERE id = ? AND n = ?', ['b', 2]), { changes: 1 })
  assert.deepEqual(await db.run('UPDATE items SET n = n + 1 WHERE id = ? AND n = ?', ['b', 2]), { changes: 0 })

  // tx commits on resolve
  await db.tx(async t => { await t.run('UPDATE items SET n = ? WHERE id = ?', [10, 'c']) })
  assert.equal((await db.get<{ n: number }>('SELECT n FROM items WHERE id = ?', ['c']))!.n, 10)
  // tx rolls back on throw
  await assert.rejects(db.tx(async t => { await t.run('UPDATE items SET n = ? WHERE id = ?', [99, 'c']); throw new Error('boom') }), /boom/)
  assert.equal((await db.get<{ n: number }>('SELECT n FROM items WHERE id = ?', ['c']))!.n, 10)
  await assert.rejects(db.tx(async t => t.tx(async () => 1)), /nested/)

  // two concurrent read-modify-write transactions on one row: no lost update
  await Promise.all([1, 2, 3, 4].map(() => db.tx(async t => {
    const r = await t.get<{ n: number }>(db.kind === 'pg' ? 'SELECT n FROM items WHERE id = ? FOR UPDATE' : 'SELECT n FROM items WHERE id = ?', ['a'])
    await new Promise(r => setTimeout(r, 5))
    await t.run('UPDATE items SET n = ? WHERE id = ?', [r!.n + 1, 'a'])
  })))
  assert.equal((await db.get<{ n: number }>('SELECT n FROM items WHERE id = ?', ['a']))!.n, 1800000004)
}

test('sqlite adapter meets the Db contract', async () => {
  const db = sqliteDb(new Database(':memory:'))
  try { await contract(db) } finally { await db.close() }
})

test('sqlite adapter: a statement outside a running transaction waits for it instead of joining it', async () => {
  const db = sqliteDb(new Database(':memory:'))
  await db.run('CREATE TABLE k (v INTEGER)')
  let release!: () => void
  const held = new Promise<void>(r => { release = r })
  const t = db.tx(async tx => { await tx.run('INSERT INTO k VALUES (1)'); await held; throw new Error('rollback') })
  const outside = db.run('INSERT INTO k VALUES (2)')
  release()
  await assert.rejects(t, /rollback/)
  await outside
  assert.deepEqual(await db.all('SELECT v FROM k'), [{ v: 2 }])
  await db.close()
})

test('pg adapter meets the Db contract', { skip: pgSkip }, async () => {
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema })
  try { await contract(db) } finally { await db.close(); await s.drop() }
})
