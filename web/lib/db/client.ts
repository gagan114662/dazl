// Async data layer: one interface over SQLite (today's runtime store) and Postgres (the target store).
// Modules move onto Db one area at a time (docs/PLATFORM.md step 2). Until a module is moved it keeps using its own
// better-sqlite3 handle, so nothing here changes runtime behaviour while DATABASE_URL is unset.
//
// SQL is written once with sqlite-style `?` placeholders; the PG adapter rewrites them to $1..$n outside string
// literals, quoted identifiers and comments. Dialect differences (strftime, INSERT OR IGNORE, rowid) are the caller's
// job: a module ported to Db must use SQL both engines accept.
import Database from 'better-sqlite3'
import pg from 'pg'

export type Param = string | number | bigint | null | boolean
export interface RunResult { changes: number }
export interface Db {
  readonly kind: 'sqlite' | 'pg'
  all<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T[]>
  get<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T | undefined>
  run(sql: string, params?: Param[]): Promise<RunResult>
  // Runs fn inside one transaction on one connection: commit when fn resolves, roll back when it throws.
  // SQLite takes the write lock up front (BEGIN IMMEDIATE), matching the existing .immediate() claims.
  // Inside fn use only the Db it is given: on SQLite a call on the outer Db waits for the transaction to end (deadlock).
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>
  close(): Promise<void>
}

// ---- placeholders ----

// `?` -> `$n`, skipping '...' strings, "..." identifiers, -- and /* */ comments. Postgres operators that contain `?`
// (jsonb ?, ?|, ?&) are not supported through this API and fail loudly instead of being renumbered.
export function toPgPlaceholders(sql: string): string {
  let out = '', n = 0, i = 0
  while (i < sql.length) {
    const ch = sql[i]
    if (ch === "'" || ch === '"') {
      const end = scanQuoted(sql, i, ch)
      out += sql.slice(i, end); i = end; continue
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i); const end = nl === -1 ? sql.length : nl
      out += sql.slice(i, end); i = end; continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2); if (close === -1) throw new Error('unterminated comment in SQL')
      out += sql.slice(i, close + 2); i = close + 2; continue
    }
    if (ch === '?') {
      if (sql[i + 1] === '|' || sql[i + 1] === '&' || sql[i + 1] === '?') throw new Error('jsonb ? operators are not supported by toPgPlaceholders')
      out += `$${++n}`; i++; continue
    }
    out += ch; i++
  }
  return out
}

function scanQuoted(sql: string, start: number, q: string): number {
  let i = start + 1
  while (i < sql.length) {
    if (sql[i] === q) { if (sql[i + 1] === q) { i += 2; continue } return i + 1 }
    i++
  }
  throw new Error('unterminated quoted string in SQL')
}

// ---- SQLite ----

// better-sqlite3 is synchronous and has one connection, so an async transaction must hold the connection for its whole
// life: statements from outside the transaction wait on `gate` until it ends instead of landing inside it.
export function sqliteDb(handle: Database.Database): Db {
  let gate: Promise<void> = Promise.resolve()
  const exec = {
    all: <T>(sql: string, params: Param[] = []) => handle.prepare(sql).all(...params) as T[],
    get: <T>(sql: string, params: Param[] = []) => handle.prepare(sql).get(...params) as T | undefined,
    run: (sql: string, params: Param[] = []) => ({ changes: handle.prepare(sql).run(...params).changes }),
  }
  const inner = (): Db => ({
    kind: 'sqlite',
    all: async (s, p) => exec.all(s, p),
    get: async (s, p) => exec.get(s, p),
    run: async (s, p) => exec.run(s, p),
    tx: () => Promise.reject(new Error('nested transactions are not supported')),
    close: () => Promise.reject(new Error('close the outer Db, not a transaction')),
  })
  const after = async <T>(f: () => T | Promise<T>): Promise<T> => { await gate; return f() }
  return {
    kind: 'sqlite',
    all: (s, p) => after(() => exec.all(s, p)),
    get: (s, p) => after(() => exec.get(s, p)),
    run: (s, p) => after(() => exec.run(s, p)),
    async tx(fn) {
      let release!: () => void
      const prev = gate
      gate = new Promise<void>(r => { release = r })
      await prev
      try {
        handle.exec('BEGIN IMMEDIATE')
        try {
          const v = await fn(inner())
          handle.exec('COMMIT')
          return v
        } catch (e) {
          if (handle.inTransaction) handle.exec('ROLLBACK')
          throw e
        }
      } finally { release() }
    },
    close: async () => { await gate; handle.close() },
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

function pgOps(q: Queryable) {
  return {
    all: async <T>(sql: string, params: Param[] = []) => (await q.query(toPgPlaceholders(sql), params)).rows as T[],
    get: async <T>(sql: string, params: Param[] = []) => (await q.query(toPgPlaceholders(sql), params)).rows[0] as T | undefined,
    run: async (sql: string, params: Param[] = []) => ({ changes: (await q.query(toPgPlaceholders(sql), params)).rowCount ?? 0 }),
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
    async tx(fn) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const t = pgOps(client)
        const inner: Db = {
          kind: 'pg', all: t.all, get: t.get, run: t.run,
          tx: () => Promise.reject(new Error('nested transactions are not supported')),
          close: () => Promise.reject(new Error('close the outer Db, not a transaction')),
        }
        const v = await fn(inner)
        await client.query('COMMIT')
        return v
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
    const { getAuthDb } = await import('../auth-db.ts')
    return sqliteDb(getAuthDb())
  })()
  return shared
}
