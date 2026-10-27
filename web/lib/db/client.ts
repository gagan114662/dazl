// Async data layer: one interface over SQLite (today's runtime store) and Postgres (the target store).
// Modules move onto Db one area at a time (docs/PLATFORM.md step 2). Until a module is moved it keeps using its own
// better-sqlite3 handle, so nothing here changes runtime behaviour while DATABASE_URL is unset.
//
// SQL is written once with sqlite-style `?` placeholders; the PG adapter rewrites them to $1..$n (see toPgPlaceholders
// for what it accepts and what it refuses). Dialect differences (strftime, INSERT OR IGNORE, rowid) are the caller's
// job: a module ported to Db must use SQL both engines accept.
import Database from 'better-sqlite3'
import pg from 'pg'

// Values both engines bind the same way. Booleans are not accepted: better-sqlite3 cannot bind them and PG would store
// a real boolean, so a caller passes 0/1 for SQLite-style INTEGER flags (the schema's convention).
export type Param = string | number | bigint | null
export interface RunResult { changes: number }
export interface Db {
  readonly kind: 'sqlite' | 'pg'
  all<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T[]>
  get<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T | undefined>
  run(sql: string, params?: Param[]): Promise<RunResult>
  // Runs body as one transaction. body is a generator that yields statements through `t` and cannot await anything
  // else, so a transaction can never pause for unrelated work:
  //   await db.tx(function* (t) { const r = yield* t.get<Row>('SELECT …', [id]); yield* t.run('UPDATE …', [id]); return r })
  // SQLite drives it synchronously inside one better-sqlite3 IMMEDIATE transaction: nothing else in the process runs
  // until it commits or rolls back, so code still on the raw handle never sees or joins a half-done transaction.
  // PG drives it on one pooled client between BEGIN and COMMIT.
  // Commit when body returns; roll back when body throws or any statement fails (a failed statement always fails the
  // transaction on both engines, as PG has already aborted it).
  tx<T>(body: (t: Tx) => TxBody<T>): Promise<T>
  close(): Promise<void>
}

// A statement a tx body yields; `t` builds them so `yield*` returns a typed result.
export interface TxOp { op: 'all' | 'get' | 'run'; sql: string; params: Param[] }
export type TxBody<T> = Generator<TxOp, T, unknown>
export interface Tx {
  readonly kind: 'sqlite' | 'pg'
  all<T = Record<string, unknown>>(sql: string, params?: Param[]): TxBody<T[]>
  get<T = Record<string, unknown>>(sql: string, params?: Param[]): TxBody<T | undefined>
  run(sql: string, params?: Param[]): TxBody<RunResult>
}

// A body that yields anything but a statement (say `yield somePromise`) is a bug: refuse it rather than guess.
function asOp(v: unknown): TxOp {
  const o = v as Partial<TxOp> | null
  if (!o || (o.op !== 'all' && o.op !== 'get' && o.op !== 'run') || typeof o.sql !== 'string' || !Array.isArray(o.params)) {
    throw new TypeError('a tx body may only yield statements built by its Tx (yield* t.get/all/run), never promises or other values')
  }
  return o as TxOp
}

function txBuilder(kind: Db['kind']): Tx {
  return {
    kind,
    *all<T>(sql: string, params: Param[] = []): TxBody<T[]> { return (yield { op: 'all', sql, params }) as T[] },
    *get<T>(sql: string, params: Param[] = []): TxBody<T | undefined> { return (yield { op: 'get', sql, params }) as T | undefined },
    *run(sql: string, params: Param[] = []): TxBody<RunResult> { return (yield { op: 'run', sql, params }) as RunResult },
  }
}

export function checkParams(params: readonly unknown[]): Param[] {
  params.forEach((v, i) => {
    const ok = v === null || typeof v === 'string' || typeof v === 'bigint' || (typeof v === 'number' && Number.isFinite(v))
    if (!ok) throw new TypeError(`unsupported SQL parameter at index ${i}: ${v === undefined ? 'undefined' : typeof v}${typeof v === 'boolean' ? ' (pass 0 or 1)' : ''}`)
  })
  return params as Param[]
}

// ---- placeholders ----

// Words after which a `?` is a value, not an operator.
const VALUE_KEYWORDS = new Set(['SELECT', 'WHERE', 'AND', 'OR', 'NOT', 'LIKE', 'ILIKE', 'GLOB', 'ESCAPE', 'BETWEEN', 'IS',
  'THEN', 'ELSE', 'WHEN', 'CASE', 'LIMIT', 'OFFSET', 'VALUES', 'SET', 'BY', 'ON', 'RETURNING', 'DISTINCT', 'ALL', 'ANY', 'IN', 'EXISTS'])

// `?` -> `$n`. A small lexer skips everything PG treats as text: '...' strings (E'...' with backslash escapes),
// "..." identifiers, $tag$...$tag$ dollar quotes, -- comments and nested /* */ comments. It refuses, instead of
// rewriting, any SQL it cannot place safely:
//  - a `?` right after an operand (a column, literal, `)` or another `?`): that is PG's jsonb `?` operator, as are
//    `?|` and `?&`, none of which this API supports;
//  - existing $1-style parameters (mixing the two styles);
//  - unterminated strings, identifiers, dollar quotes or comments.
export function toPgPlaceholders(sql: string): string {
  let out = '', n = 0, i = 0
  // What came before, for the operand test: 'op' (start, punctuation, operator), 'kw' (value keyword), 'operand'.
  let prev: 'op' | 'kw' | 'operand' = 'op'
  const isIdStart = (c: string | undefined) => !!c && /[A-Za-z_\u0080-\uffff]/.test(c)
  const isId = (c: string | undefined) => !!c && /[A-Za-z0-9_$\u0080-\uffff]/.test(c)
  while (i < sql.length) {
    const ch = sql[i]
    if (/\s/.test(ch)) { out += ch; i++; continue }
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i); const end = nl === -1 ? sql.length : nl
      out += sql.slice(i, end); i = end; continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1, j = i + 2
      while (j < sql.length && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2 } else if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2 } else j++
      }
      if (depth > 0) throw new Error('unterminated comment in SQL')
      out += sql.slice(i, j); i = j; continue
    }
    if (ch === "'" || ch === '"') {
      const end = scanQuoted(sql, i, ch, false)
      out += sql.slice(i, end); i = end; prev = 'operand'; continue
    }
    if (ch === '$') {
      if (/[0-9]/.test(sql[i + 1] ?? '')) throw new Error('SQL already uses $n parameters; write ? placeholders only')
      const m = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/)
      if (!m) throw new Error(`unexpected $ in SQL at ${i}`)
      const close = sql.indexOf(m[0], i + m[0].length)
      if (close === -1) throw new Error('unterminated dollar-quoted string in SQL')
      const end = close + m[0].length
      out += sql.slice(i, end); i = end; prev = 'operand'; continue
    }
    if (isIdStart(ch)) {
      let j = i + 1
      while (isId(sql[j])) j++
      const word = sql.slice(i, j)
      if ((word === 'E' || word === 'e') && sql[j] === "'") {
        const end = scanQuoted(sql, j, "'", true)
        out += sql.slice(i, end); i = end; prev = 'operand'; continue
      }
      out += word; i = j; prev = VALUE_KEYWORDS.has(word.toUpperCase()) ? 'kw' : 'operand'; continue
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      let j = i + 1
      while (/[0-9.eE]/.test(sql[j] ?? '') || ((sql[j] === '+' || sql[j] === '-') && /[eE]/.test(sql[j - 1]))) j++
      out += sql.slice(i, j); i = j; prev = 'operand'; continue
    }
    if (ch === '?') {
      if (sql[i + 1] === '|' || sql[i + 1] === '&') throw new Error('jsonb ?| / ?& operators are not supported through Db')
      if (prev === 'operand') throw new Error(`? at ${i} follows an operand, so it would be a jsonb operator, not a parameter; not supported through Db`)
      out += `$${++n}`; i++; prev = 'operand'; continue
    }
    out += ch; i++
    prev = ch === ')' || ch === ']' ? 'operand' : 'op'
  }
  return out
}

function scanQuoted(sql: string, start: number, q: string, backslash: boolean): number {
  let i = start + 1
  while (i < sql.length) {
    if (backslash && sql[i] === '\\') { i += 2; continue }
    if (sql[i] === q) { if (sql[i + 1] === q) { i += 2; continue } return i + 1 }
    i++
  }
  throw new Error(q === '"' ? 'unterminated quoted identifier in SQL' : 'unterminated quoted string in SQL')
}

// ---- transactions ----

export class StatementFailedInTx extends Error {
  constructor(cause: unknown) { super(`a statement failed inside the transaction, so it was rolled back: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }) }
}

type Ops = { all: Db['all']; get: Db['get']; run: Db['run'] }

// ---- SQLite ----

export function sqliteDb(handle: Database.Database): Db {
  const exec = (o: TxOp): unknown => {
    const st = handle.prepare(o.sql)
    const p = checkParams(o.params)
    return o.op === 'all' ? st.all(...p) : o.op === 'get' ? st.get(...p) : { changes: st.run(...p).changes }
  }
  const t = txBuilder('sqlite')
  const ops: Ops = {
    all: async <T>(sql: string, params: Param[] = []) => exec({ op: 'all', sql, params }) as T[],
    get: async <T>(sql: string, params: Param[] = []) => exec({ op: 'get', sql, params }) as T | undefined,
    run: async (sql: string, params: Param[] = []) => exec({ op: 'run', sql, params }) as RunResult,
  }
  return {
    kind: 'sqlite',
    ...ops,
    async tx(body) {
      // Synchronous from BEGIN to COMMIT: the generator only ever waits on statements, which run immediately here.
      return handle.transaction(() => {
        const g = body(t)
        let step = g.next()
        while (!step.done) {
          const o = asOp(step.value)
          let v: unknown
          try { v = exec(o) } catch (e) { throw new StatementFailedInTx(e) }
          step = g.next(v)
        }
        return step.value
      }).immediate()
    },
    close: async () => { handle.close() },
  }
}

// ---- Postgres ----

// int8 (OID 20) comes back from the pg driver as a string. Every INTEGER column is BIGINT in the translated schema
// (epoch seconds), so parse it to a number, and fail loudly beyond 2^53 instead of losing precision.
const INT8 = 20
export function parseInt8(v: string): number {
  const n = Number(v)
  if (!Number.isSafeInteger(n)) throw new Error(`unsafe integer from pg: ${v}`)
  return n
}
const types = {
  getTypeParser: ((oid: number, format?: string) => oid === INT8 ? parseInt8 : pg.types.getTypeParser(oid, format as 'text')) as typeof pg.types.getTypeParser,
}

type Queryable = { query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }> }

function pgOps(q: Queryable): Ops {
  const query = async (sql: string, params: Param[] = []) => q.query(toPgPlaceholders(sql), checkParams(params))
  return {
    all: async <T>(sql: string, params?: Param[]) => (await query(sql, params)).rows as T[],
    get: async <T>(sql: string, params?: Param[]) => (await query(sql, params)).rows[0] as T | undefined,
    run: async (sql: string, params?: Param[]) => ({ changes: (await query(sql, params)).rowCount ?? 0 }),
  }
}

export interface PgOptions { connectionString: string; max?: number; searchPath?: string }

export function pgDb(opts: PgOptions): Db & { pool: pg.Pool } {
  if (opts.searchPath !== undefined && !/^[a-z_][a-z0-9_]*$/.test(opts.searchPath)) throw new Error('invalid search_path')
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    types,
    ...(opts.searchPath ? { options: `-c search_path=${opts.searchPath}` } : {}),
  })
  const ops = pgOps(pool)
  return {
    kind: 'pg',
    pool,
    all: ops.all, get: ops.get, run: ops.run,
    async tx(body) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const run = pgOps(client)
        const g = body(txBuilder('pg'))
        let step = g.next()
        while (!step.done) {
          const o = asOp(step.value)
          let v: unknown
          try { v = await (o.op === 'all' ? run.all(o.sql, o.params) : o.op === 'get' ? run.get(o.sql, o.params) : run.run(o.sql, o.params)) } catch (e) { throw new StatementFailedInTx(e) }
          step = g.next(v)
        }
        await client.query('COMMIT')
        return step.value
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        throw e
      } finally { client.release() }
    },
    close: () => pool.end(),
  }
}

// ---- selection ----

let shared: Promise<Db> | null = null

// DATABASE_URL set -> Postgres; otherwise the app's existing SQLite handle. Production must not set DATABASE_URL until
// the owner authorizes the cutover (docs/PLATFORM.md, "Production go/no-go").
export function getDb(): Promise<Db> {
  shared ??= (async () => {
    const url = process.env.DATABASE_URL
    if (url) return pgDb({ connectionString: url })
    // getScanDb runs every module's sqlite migrate*() once, so ported modules find their tables.
    const { getScanDb } = await import('../scan/service.ts')
    const { migratePlatform } = await import('./platform-tables.ts')
    const raw = getScanDb()
    migratePlatform(raw)
    return sqliteDb(raw)
  })()
  return shared
}
