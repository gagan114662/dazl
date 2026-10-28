// Copies every table of one store into another, empty one, and proves the copy (docs/PLATFORM.md "Postgres cutover"):
// SQLite file -> Postgres for the cutover, Postgres -> a new SQLite file for a rollback after Postgres took writes.
//   - The target must already have the schema (PG migrations / migrateAllSqlite) and hold no rows: nothing is merged
//     or overwritten.
//   - Every source table with rows must exist in the target with every source column; otherwise nothing is copied.
//   - One target transaction: rows go in parents-first (foreign keys), with the target's guard triggers off for the copy
//     only (they police live writes: "leads only while the job is running" would refuse a finished job's leads). Before
//     commit, each table's row count and a checksum of its full content are compared with the source; any difference
//     rolls the whole copy back, so the target is either a verified copy or untouched.
// The source is only read. It must not change while the copy runs: stop the app (docs/PLATFORM.md) first.
// Memory: each table is read whole. Fine for today's store size; batch by key if a table outgrows memory.
import { createHash } from 'node:crypto'
import type { Db, Param, Tx, TxBody } from './client.ts'

export interface TableCopy { table: string; rows: number; checksum: string }
export interface CopyReport { from: Db['kind']; to: Db['kind']; tables: TableCopy[]; skipped: string[] }

export class CopyRefused extends Error { constructor(m: string) { super(m); this.name = 'CopyRefused' } }
export class CopyVerifyError extends Error { constructor(m: string) { super(m); this.name = 'CopyVerifyError' } }

// Bookkeeping that belongs to one engine: never copied.
const ENGINE_TABLES = new Set(['dazl_schema_migrations'])
// Rows a migration itself inserts (the queue's fencing-token counter): the target's are replaced by the source's, so
// the counter carries over and no token is ever handed out twice.
const SEEDED_BY_MIGRATION = new Set(['work_queue_meta'])
const ident = (n: string) => { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) throw new CopyRefused(`unexpected identifier ${JSON.stringify(n)}`); return `"${n}"` }

async function tables(db: Db): Promise<string[]> {
  const rows = db.kind === 'pg'
    ? await db.all<{ n: string }>("SELECT table_name AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'")
    : await db.all<{ n: string }>("SELECT name AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
  return rows.map(r => r.n).filter(n => !ENGINE_TABLES.has(n)).sort()
}

async function columns(db: Db, table: string): Promise<string[]> {
  const rows = db.kind === 'pg'
    ? await db.all<{ n: string }>('SELECT column_name AS n FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position', [table])
    : await db.all<{ n: string }>('SELECT name AS n FROM pragma_table_info(?) ORDER BY cid', [table])
  return rows.map(r => r.n)
}

// child -> parents, from whichever side declares the foreign key
async function parents(db: Db, names: string[]): Promise<Map<string, Set<string>>> {
  const m = new Map<string, Set<string>>(names.map(n => [n, new Set()]))
  const add = (c: string, p: string) => { if (c !== p && m.has(c) && m.has(p)) m.get(c)!.add(p) }
  if (db.kind === 'pg') {
    const rows = await db.all<{ c: string; p: string }>(
      "SELECT cl.relname AS c, pa.relname AS p FROM pg_constraint k JOIN pg_class cl ON cl.oid = k.conrelid JOIN pg_class pa ON pa.oid = k.confrelid WHERE k.contype = 'f' AND k.connamespace = current_schema()::regnamespace")
    for (const r of rows) add(r.c, r.p)
  } else {
    for (const n of names) for (const r of await db.all<{ p: string }>('SELECT "table" AS p FROM pragma_foreign_key_list(?)', [n])) add(n, r.p)
  }
  return m
}

function parentsFirst(names: string[], deps: Map<string, Set<string>>): string[] {
  const out: string[] = [], state = new Map<string, 'doing' | 'done'>()
  const visit = (n: string) => {
    if (state.get(n) === 'done' || state.get(n) === 'doing') return // a cycle keeps the order it reached
    state.set(n, 'doing')
    for (const p of [...(deps.get(n) ?? [])].sort()) visit(p)
    state.set(n, 'done'); out.push(n)
  }
  for (const n of names) visit(n)
  return out
}

// Engine-neutral content: each value as text (numbers through String, so 7 and '7' from a BIGINT read the same), rows
// sorted, so the checksum depends on the data only, not on either engine's row order or number types.
function checksum(rows: Record<string, unknown>[], cols: string[]): string {
  const lines = rows.map(r => JSON.stringify(cols.map(c => r[c] === null || r[c] === undefined ? null : String(r[c])))).sort()
  const h = createHash('sha256')
  for (const l of lines) h.update(l).update('\n')
  return h.digest('hex')
}

function toParam(v: unknown, where: string): Param {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return v
  throw new CopyRefused(`${where}: value of type ${typeof v} cannot be copied`)
}

export async function copyStore(src: Db, dst: Db, opts: { batch?: number } = {}): Promise<CopyReport> {
  const batch = opts.batch ?? 200
  const srcTables = await tables(src), dstTables = new Set(await tables(dst))
  const plan: { table: string; cols: string[]; rows: Record<string, unknown>[]; sum: string }[] = []
  const skipped: string[] = []
  for (const t of srcTables) {
    const cols = await columns(src, t)
    const rows = await src.all(`SELECT * FROM ${ident(t)}`)
    if (!dstTables.has(t)) {
      if (rows.length) throw new CopyRefused(`table ${t} has ${rows.length} rows but no table in the target: migrate the target first`)
      skipped.push(t); continue
    }
    const dcols = new Set(await columns(dst, t))
    const missing = cols.filter(c => !dcols.has(c))
    if (missing.length) throw new CopyRefused(`table ${t}: the target has no column ${missing.join(', ')}: migrate the target first`)
    plan.push({ table: t, cols, rows, sum: checksum(rows, cols) })
  }
  for (const t of dstTables) {
    if (SEEDED_BY_MIGRATION.has(t)) continue
    const n = Number((await dst.get<{ c: number }>(`SELECT count(*) AS c FROM ${ident(t)}`))!.c)
    if (n > 0) throw new CopyRefused(`the target is not empty (${t} has ${n} rows): copy only into a freshly migrated store`)
  }
  const deps = await parents(dst.kind === 'pg' ? dst : src, plan.map(p => p.table))
  const order = parentsFirst(plan.map(p => p.table), deps).map(t => plan.find(p => p.table === t)!)
  // SQLite triggers cannot be switched off: drop them for the copy and recreate them from their own DDL before commit.
  const sqliteTriggers = dst.kind === 'sqlite' ? await dst.all<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'") : []
  const pgTriggerTables = dst.kind === 'pg'
    ? (await dst.all<{ t: string }>("SELECT DISTINCT c.relname AS t FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE NOT g.tgisinternal AND c.relnamespace = current_schema()::regnamespace")).map(r => r.t)
    : []

  const pgSequences = dst.kind === 'pg'
    ? (await dst.all<{ table: string; column: string }>("SELECT table_name AS \"table\", column_name AS \"column\" FROM information_schema.columns WHERE table_schema = current_schema() AND (is_identity = 'YES' OR column_default LIKE 'nextval(%')"))
      .filter(s => plan.some(p => p.table === s.table && p.cols.includes(s.column)))
    : []

  await dst.tx(function* (t: Tx): TxBody<void> {
    for (const g of sqliteTriggers) yield* t.run(`DROP TRIGGER ${ident(g.name)}`)
    for (const n of pgTriggerTables) yield* t.run(`ALTER TABLE ${ident(n)} DISABLE TRIGGER USER`)
    for (const p of order) {
      const cols = p.cols.map(ident).join(', ')
      if (SEEDED_BY_MIGRATION.has(p.table)) yield* t.run(`DELETE FROM ${ident(p.table)}`)
      for (let i = 0; i < p.rows.length; i += batch) {
        const chunk = p.rows.slice(i, i + batch)
        const values = chunk.map(() => `(${p.cols.map(() => '?').join(', ')})`).join(', ')
        yield* t.run(`INSERT INTO ${ident(p.table)} (${cols}) VALUES ${values}`, chunk.flatMap(r => p.cols.map(c => toParam(r[c], `${p.table}.${c}`))))
      }
      const got = yield* t.all(`SELECT ${cols} FROM ${ident(p.table)}`)
      if (got.length !== p.rows.length) throw new CopyVerifyError(`${p.table}: ${p.rows.length} rows in the source, ${got.length} in the target`)
      if (checksum(got, p.cols) !== p.sum) throw new CopyVerifyError(`${p.table}: content differs from the source after the copy`)
    }
    for (const n of pgTriggerTables) yield* t.run(`ALTER TABLE ${ident(n)} ENABLE TRIGGER USER`)
    // Sequences behind copied columns (identity ids, insert_seq) continue after the largest copied value; otherwise
    // the first insert after the copy would reuse an id or sort before rows it came after.
    for (const s of pgSequences) yield* t.get(`SELECT setval(pg_get_serial_sequence(?, ?), coalesce((SELECT max(${ident(s.column)}) FROM ${ident(s.table)}), 0) + 1, false) AS v`, [s.table, s.column])
    for (const g of sqliteTriggers) yield* t.run(g.sql)
  })
  return { from: src.kind, to: dst.kind, tables: order.map(p => ({ table: p.table, rows: p.rows.length, checksum: p.sum })), skipped }
}

// After a copy, or any time later: each table's row count and content checksum on both stores. A cutover proceeds
// only when this is empty.
export async function compareStores(a: Db, b: Db): Promise<string[]> {
  const diffs: string[] = []
  const ta = await tables(a), tb = new Set(await tables(b))
  for (const t of ta) {
    const cols = await columns(a, t)
    const ra = await a.all(`SELECT * FROM ${ident(t)}`)
    if (!tb.has(t)) { if (ra.length) diffs.push(`${t}: missing from the target`); continue }
    const rb = await b.all(`SELECT ${cols.map(ident).join(', ')} FROM ${ident(t)}`)
    if (ra.length !== rb.length) diffs.push(`${t}: ${ra.length} rows vs ${rb.length}`)
    else if (checksum(ra, cols) !== checksum(rb, cols)) diffs.push(`${t}: same row count, different content`)
  }
  for (const t of tb) {
    if (ta.includes(t)) continue
    const n = Number((await b.get<{ c: number }>(`SELECT count(*) AS c FROM ${ident(t)}`))!.c)
    if (n) diffs.push(`${t}: ${n} rows only in the target`)
  }
  return diffs
}
