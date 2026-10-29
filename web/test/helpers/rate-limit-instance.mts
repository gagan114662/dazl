// One fresh "app instance" for test/rate-limit-degraded.test.ts: its own process, its own (empty) per-process limiter,
// over the shared store, or over a store it cannot write to (CHILD_BROKEN=1: the SQLite file opened read-only, or an
// unreachable Postgres). Spends CHILD_CALLS concurrent calls of CHILD_BUCKET at CHILD_LIMIT and prints what it got.
// Every fetch is counted: a rate-limit decision must never reach a provider.
import Database from 'better-sqlite3'
import { pgDb, sqliteDb, type Db } from '../../lib/db/client.ts'
import { rateLimit } from '../../lib/rate-limit.ts'

let fetches = 0
globalThis.fetch = (async () => { fetches++; throw new Error('network fenced') }) as typeof fetch
console.error = () => {}
const broken = process.env.CHILD_BROKEN === '1'
let db: Db
if (process.env.CHILD_SQLITE) {
  const raw = new Database(process.env.CHILD_SQLITE, { readonly: broken })
  raw.pragma('busy_timeout = 10000')
  db = sqliteDb(raw)
} else {
  db = pgDb({ connectionString: broken ? 'postgres://nobody@127.0.0.1:1/none' : process.env.DAZL_TEST_PG_URL!, searchPath: process.env.CHILD_PG_SCHEMA, max: 8 })
}
// optional start line shared by concurrent instances (a file timestamp in ms), so their calls overlap
const at = Number(process.env.CHILD_START_AT || 0)
if (at > Date.now()) await new Promise(r => setTimeout(r, at - Date.now()))
const rs = await Promise.all(Array.from({ length: Number(process.env.CHILD_CALLS) }, () => rateLimit(process.env.CHILD_BUCKET!, Number(process.env.CHILD_LIMIT), 60_000, db)))
await db.close().catch(() => {})
process.stdout.write(JSON.stringify({ allowed: rs.filter(r => r.ok).length, unavailable: rs.filter(r => r.unavailable).length, fetches }))
