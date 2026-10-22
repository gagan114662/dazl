// Write fence: a reversible, env-gated write pause for migration windows.
// PREPARATION ONLY - not wired into any route or db getter yet. Wiring and any
// production use require explicit authorization; the external worker (Hermes)
// writes via its own tunnel and is NOT covered by this fence - the migration
// runbook must pause it separately (see docs/write-fence.md).
//
// Design: when fenced, openFencedDb returns a READ-ONLY better-sqlite3 handle,
// so every write path through that handle fails at the SQLite layer regardless
// of which route or cron job attempts it. A process already holding a write
// handle is unaffected - the fence applies at open time, so a rolling restart
// (or fresh process start) is required. That limitation is deliberate and
// documented; it is not a distributed lock.
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'

export const FENCE_ENV = 'DAZL_WRITE_FENCE'
export const FENCE_FILE_ENV = 'DAZL_WRITE_FENCE_FILE'

export function writeFenceActive(env: Record<string, string | undefined> = process.env): boolean {
  if (env[FENCE_ENV] === '1') return true
  const f = env[FENCE_FILE_ENV]
  return !!f && existsSync(f)
}

// Opens the app's DB read-only when the fence is active. Callers treat a throw
// from a write as "maintenance in progress" (HTTP 503 + Retry-After at the
// route layer, once wired).
export function openFencedDb(path: string, env: Record<string, string | undefined> = process.env): Database.Database {
  const fenced = writeFenceActive(env)
  const db = new Database(path, { readonly: fenced })
  db.pragma('journal_mode = WAL')
  return db
}
