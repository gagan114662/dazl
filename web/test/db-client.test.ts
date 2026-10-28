import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { sqliteDb, pgDb, toPgPlaceholders, parseInt8, StatementFailedInTx } from '../lib/db/client.ts'
import type { Param, Tx, TxOp } from '../lib/db/client.ts'
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

  // tx commits when the body returns
  await db.tx(function* (t) { yield* t.run('UPDATE items SET n = ? WHERE id = ?', [10, 'c']) })
  assert.equal((await db.get<{ n: number }>('SELECT n FROM items WHERE id = ?', ['c']))!.n, 10)
  // and returns the body's value, with typed statement results
  assert.equal(await db.tx(function* (t) { return (yield* t.get<{ n: number }>('SELECT n FROM items WHERE id = ?', ['c']))!.n + 1 }), 11)
  // tx rolls back when the body throws
  await assert.rejects(db.tx(function* (t) { yield* t.run('UPDATE items SET n = ? WHERE id = ?', [99, 'c']); throw new Error('boom') }), /boom/)
  assert.equal((await db.get<{ n: number }>('SELECT n FROM items WHERE id = ?', ['c']))!.n, 10)

  // concurrent read-modify-write transactions on one row: no lost update
  await Promise.all([1, 2, 3, 4].map(() => db.tx(function* (t) {
    const r = yield* t.get<{ n: number }>(db.kind === 'pg' ? 'SELECT n FROM items WHERE id = ? FOR UPDATE' : 'SELECT n FROM items WHERE id = ?', ['a'])
    yield* t.run('UPDATE items SET n = ? WHERE id = ?', [r!.n + 1, 'a'])
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

// A tx body is a generator: it can only run statements, only while the driver is running it, and any failure fails the
// whole transaction.
async function txBodies(db: Db) {
  await db.run('CREATE TABLE w (v INTEGER)')
  const values = async () => (await db.all<{ v: number }>('SELECT v FROM w ORDER BY v')).map(r => r.v)
  let old!: Tx
  await db.tx(function* (t) { old = t; yield* t.run('INSERT INTO w (v) VALUES (?)', [1]) })
  // a Tx that escaped its transaction only builds statement descriptions; running it later touches no connection
  const escaped = old.run('INSERT INTO w (v) VALUES (?)', [999])
  assert.deepEqual(escaped.next().value, { op: 'run', sql: 'INSERT INTO w (v) VALUES (?)', params: [999] })
  // ...even while another transaction is open on the same (single) connection
  await db.tx(function* (t) { yield* t.run('INSERT INTO w (v) VALUES (?)', [2]); escaped.next({ changes: 1 }); old.get('SELECT 1').next() })

  // a body that yields anything but a statement is refused and rolled back
  await assert.rejects(db.tx(function* (t) {
    yield* t.run('INSERT INTO w (v) VALUES (?)', [3])
    yield new Promise(r => setTimeout(r, 1)) as unknown as TxOp
  }), /may only yield statements/)

  // a failed statement fails the transaction; the body never gets to swallow it
  let swallowed = false
  await assert.rejects(db.tx(function* (t) {
    yield* t.run('INSERT INTO w (v) VALUES (?)', [4])
    try { yield* t.run('INSERT INTO no_such_table (v) VALUES (?)', [5]) } catch { swallowed = true }
    yield* t.run('INSERT INTO w (v) VALUES (?)', [6])
  }), StatementFailedInTx)
  assert.equal(swallowed, false)
  await assert.rejects(db.tx(function* (t) {
    yield* t.run('INSERT INTO w (v) VALUES (?)', [7])
    yield* t.run('INSERT INTO w (v) VALUES (?)', [true as unknown as Param])
  }), /statement failed inside the transaction.*pass 0 or 1/)

  assert.deepEqual(await values(), [1, 2])
}

for (const [name, f] of [['meets the Db contract', contract], ['binds only portable parameters', params], ['runs tx bodies as statement-only generators', txBodies]] as const) {
  test(`sqlite adapter ${name}`, async () => {
    const db = sqliteDb(new Database(':memory:'))
    try { await f(db) } finally { await db.close() }
  })
  test(`pg adapter ${name}`, { skip: pgSkip }, async () => {
    const s = await freshSchema()
    // txBodies: one pooled connection, so every transaction reuses the client an escaped Tx came from.
    // The others keep a real pool so concurrent transactions contend on separate connections.
    const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: f === txBodies ? 1 : 10 })
    try { await f(db) } finally { await db.close(); await s.drop() }
  })
}

test('sqlite: a transaction runs start to finish without letting other code in', async () => {
  const raw = new Database(':memory:')
  const db = sqliteDb(raw)
  raw.exec('CREATE TABLE m (v INTEGER)')
  const counted = raw.prepare('SELECT count(*) AS n FROM m') // prepared before, like unported modules do
  const seen: number[] = []
  // interleave raw reads (microtasks of other "requests") with transactions that each insert two rows
  await Promise.all(Array.from({ length: 50 }, (_, i) => i % 2
    ? db.tx(function* (t) { yield* t.run('INSERT INTO m (v) VALUES (?)', [i]); yield* t.run('INSERT INTO m (v) VALUES (?)', [i]) })
    : (async () => { await null; seen.push((counted.get() as { n: number }).n) })()))
  assert.ok(seen.every(n => n % 2 === 0), `a reader saw a half-done transaction: ${seen}`)
  assert.equal((counted.get() as { n: number }).n, 50)
  await db.close()
})
