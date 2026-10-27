import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { sqliteDb, pgDb, toPgPlaceholders, parseInt8 } from '../lib/db/client.ts'
import type { Param } from '../lib/db/client.ts'
import type { Db } from '../lib/db/client.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'

test('placeholders: ? becomes $n outside strings, identifiers and comments', () => {
  assert.equal(toPgPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?'), 'SELECT * FROM t WHERE a = $1 AND b = $2')
  assert.equal(toPgPlaceholders("SELECT '?', 'it''s ?', \"q?\" FROM t WHERE a = ? -- why?\n AND b = ? /* ? */"),
    "SELECT '?', 'it''s ?', \"q?\" FROM t WHERE a = $1 -- why?\n AND b = $2 /* ? */")
  assert.equal(toPgPlaceholders('SELECT ? LIMIT ? OFFSET ?'), 'SELECT $1 LIMIT $2 OFFSET $3')
  assert.equal(toPgPlaceholders('UPDATE t SET a = CASE WHEN b IN (?, ?) THEN ? ELSE ? END WHERE c BETWEEN ? AND ?'),
    'UPDATE t SET a = CASE WHEN b IN ($1, $2) THEN $3 ELSE $4 END WHERE c BETWEEN $5 AND $6')
  assert.equal(toPgPlaceholders('INSERT INTO t (a, b) VALUES (?, ?::text) RETURNING id'), 'INSERT INTO t (a, b) VALUES ($1, $2::text) RETURNING id')
})

test('placeholders: dollar quotes, nested comments and E-strings stay as written', () => {
  assert.equal(toPgPlaceholders('SELECT $$why?$$, ?'), 'SELECT $$why?$$, $1')
  assert.equal(toPgPlaceholders('SELECT $tag$a ? $$ b?$tag$, ?'), 'SELECT $tag$a ? $$ b?$tag$, $1')
  assert.equal(toPgPlaceholders('SELECT 1 /* outer /* inner */ ? */ WHERE a = ?'), 'SELECT 1 /* outer /* inner */ ? */ WHERE a = $1')
  assert.equal(toPgPlaceholders("SELECT E'it\\'s ?', ?"), "SELECT E'it\\'s ?', $1")
  assert.equal(toPgPlaceholders('SELECT col$x FROM t WHERE a = ?'), 'SELECT col$x FROM t WHERE a = $1')
})

test('placeholders: SQL it cannot place safely is refused, never rewritten', () => {
  assert.throws(() => toPgPlaceholders("SELECT 'open"), /unterminated quoted string/)
  assert.throws(() => toPgPlaceholders('SELECT "open'), /unterminated quoted identifier/)
  assert.throws(() => toPgPlaceholders('SELECT $$open'), /unterminated dollar-quoted/)
  assert.throws(() => toPgPlaceholders('SELECT 1 /* a /* b */'), /unterminated comment/)
  assert.throws(() => toPgPlaceholders("SELECT data ? 'k' FROM t"), /jsonb operator/)
  assert.throws(() => toPgPlaceholders("SELECT (data) ? 'k' FROM t"), /jsonb operator/)
  assert.throws(() => toPgPlaceholders('SELECT j ?| array[?]'), /jsonb/)
  assert.throws(() => toPgPlaceholders('SELECT j ?& array[?]'), /jsonb/)
  assert.throws(() => toPgPlaceholders('SELECT ? ?'), /jsonb operator/)
  assert.throws(() => toPgPlaceholders('SELECT a FROM t WHERE b = $1 AND c = ?'), /\$n parameters/)
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

// Parameters bind the same way on both engines, and anything else is refused the same way.
async function params(db: Db) {
  await db.run('CREATE TABLE p (v INTEGER)')
  for (const bad of [true, false, undefined, Number.NaN, Infinity, {}, [1]]) {
    await assert.rejects(db.run('INSERT INTO p (v) VALUES (?)', [bad as unknown as Param]), TypeError)
  }
  await db.run('INSERT INTO p (v) VALUES (?)', [1])
  await db.run('INSERT INTO p (v) VALUES (?)', [null])
  await db.run('INSERT INTO p (v) VALUES (?)', [BigInt(5)])
  assert.deepEqual((await db.all<{ v: number | null }>('SELECT v FROM p ORDER BY v')).map(r => r.v === null ? null : Number(r.v)).sort(), [1, 5, null])
}

// A tx handle is usable only while its callback runs; after that it can never reach a connection again.
async function txSafety(db: Db) {
  await db.run('CREATE TABLE w (v INTEGER)')
  const values = async () => (await db.all<{ v: number }>('SELECT v FROM w ORDER BY v')).map(r => r.v)
  let old!: Db
  await db.tx(async t => { old = t; await t.run('INSERT INTO w (v) VALUES (?)', [1]) })
  await assert.rejects(old.run('INSERT INTO w (v) VALUES (?)', [998]), /transaction is over/)

  // reviewer's repro: an escaped handle used while an unrelated transaction is open must not join it
  let release!: () => void
  const held = new Promise<void>(r => { release = r })
  let inserted!: () => void
  const other2 = new Promise<void>(r => { inserted = r })
  const other = db.tx(async t => { await t.run('INSERT INTO w (v) VALUES (?)', [2]); inserted(); await held; throw new Error('roll back the other tx') })
  await other2
  await assert.rejects(old.run('INSERT INTO w (v) VALUES (?)', [999]), /transaction is over/)
  release()
  await assert.rejects(other, /roll back the other tx/)

  // a delayed callback that escaped the transaction, then a later transaction on the reused connection
  const late: unknown[] = []
  await db.tx(async t => {
    await t.run('INSERT INTO w (v) VALUES (?)', [3])
    setTimeout(() => { t.run('INSERT INTO w (v) VALUES (?)', [997]).catch(e => late.push(e)) }, 20)
  })
  await db.tx(async t => {
    await new Promise(r => setTimeout(r, 40))
    await t.run('INSERT INTO w (v) VALUES (?)', [4])
  })
  assert.equal(late.length, 1)
  assert.match(String(late[0]), /transaction is over/)

  // a statement issued but not awaited inside the callback still belongs to the transaction and is waited for
  await db.tx(async t => { void t.run('INSERT INTO w (v) VALUES (?)', [5]) })

  // a failed statement the callback swallowed rolls the whole transaction back on both engines
  await assert.rejects(db.tx(async t => {
    await t.run('INSERT INTO w (v) VALUES (?)', [6])
    await t.run('INSERT INTO no_such_table (v) VALUES (?)', [7]).catch(() => {})
  }), /statement failed inside the transaction/)
  await assert.rejects(db.tx(async t => {
    await t.run('INSERT INTO w (v) VALUES (?)', [8])
    void t.run('INSERT INTO w (v) VALUES (?)', [true as unknown as Param]).catch(() => {})
  }), /statement failed inside the transaction/)

  assert.deepEqual(await values(), [1, 3, 4, 5])
}

for (const [name, f] of [['meets the Db contract', contract], ['binds only portable parameters', params], ['revokes tx handles and never mixes transactions', txSafety]] as const) {
  test(`sqlite adapter ${name}`, async () => {
    const db = sqliteDb(new Database(':memory:'))
    try { await f(db) } finally { await db.close() }
  })
  test(`pg adapter ${name}`, { skip: pgSkip }, async () => {
    const s = await freshSchema()
    // txSafety: one pooled connection, so every transaction reuses the client an escaped handle came from.
    // The others keep a real pool so concurrent transactions contend on separate connections.
    const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: f === txSafety ? 1 : 10 })
    try { await f(db) } finally { await db.close(); await s.drop() }
  })
}

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
