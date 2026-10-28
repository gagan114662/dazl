// Liveness and readiness (docs/PLATFORM.md step 6).
// Liveness: the process answers. No dependency is touched, so a slow database never gets a healthy process restarted.
// Readiness: this instance can serve: the store answers (Postgres when DATABASE_URL is set, else SQLite), its schema
// has every migration this build ships (Postgres), and the SQLite file the raw-handle modules still use answers.
// Each check has a 2 s budget (timed() says what it can and cannot interrupt). The response names which check failed,
// never why: the error itself goes to captureError (stderr / alert hook), since /api/health is public.
// store: which engine this instance serves from and its migration version, so a deploy can be verified from outside
// (docs/PLATFORM.md "Postgres cutover"). split: on Postgres, modules still on the raw SQLite handle would keep reading
// and writing the SQLite file, splitting the data between two stores, so the instance is not ready while any remain.
import type { Db } from '../db/client.ts'
import { captureError } from './errors.ts'

export type CheckResult = { ok: true; ms: number } | { ok: false; ms: number; reason: 'error' | 'timeout' | 'behind' }
export interface Readiness {
  ok: boolean
  // applied: the highest PG migration recorded in the store (null on SQLite, or when it could not be read)
  store: { engine: Db['kind'] | 'unknown'; migrations: { shipped: number; applied: number | null }; raw_sqlite_modules: number }
  checks: {
    store: CheckResult & { engine: Db['kind'] | 'unknown' }
    schema: CheckResult | { ok: true; skipped: 'sqlite' }
    sqlite: CheckResult
    split: { ok: true; skipped: 'sqlite' } | { ok: boolean; raw_sqlite_modules: number }
  }
}

export interface ReadinessDeps {
  db: () => Promise<Db>
  sqlite: () => { prepare(sql: string): { get(): unknown } }
  // versions of the PG migrations this build ships (lib/db/migrations/pg)
  migrations: () => number[]
  // modules still on the raw SQLite handle (lib/db/pg-port-status.ts); 0 when every module is on Db
  rawSqliteModules?: () => number
  timeoutMs?: number
  clock?: () => number
}

class Timeout extends Error { constructor() { super('readiness check timed out'); this.name = 'Timeout' } }

// The timer only bounds asynchronous waits (the PG pool, network I/O): it starts before the check and rejects when the
// event loop gets to it. Synchronous work (better-sqlite3 queries, opening and migrating the SQLite file on first use)
// cannot be cut short on this thread: the probe waits for it, so a SQLite call blocked on a lock holds the probe for up
// to better-sqlite3's busy timeout (5 s by default). Such a check is still reported as failed ('timeout') when it
// returns over budget, so a slow store never reads as ready.
async function timed(name: string, f: () => Promise<'ok' | 'behind'>, timeoutMs: number, clock: () => number): Promise<CheckResult> {
  const t0 = clock()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Timeout()), timeoutMs) })
  try {
    const r = await Promise.race([Promise.resolve().then(f), deadline])
    const ms = clock() - t0
    if (ms > timeoutMs) throw new Timeout() // finished, but over budget (synchronous work the timer could not preempt)
    return r === 'ok' ? { ok: true, ms } : { ok: false, ms, reason: 'behind' }
  } catch (e) {
    captureError(e, { source: 'health', where: `readiness:${name}` })
    return { ok: false, ms: clock() - t0, reason: e instanceof Timeout ? 'timeout' : 'error' }
  } finally { clearTimeout(timer); deadline.catch(() => {}) }
}

export async function readiness(d: ReadinessDeps): Promise<Readiness> {
  const timeoutMs = d.timeoutMs ?? 2000, clock = d.clock ?? Date.now
  let db: Db | undefined
  const store = await timed('store', async () => { db = await d.db(); await db.get('SELECT 1 AS x'); return 'ok' }, timeoutMs, clock)
  const engine = db?.kind ?? 'unknown'
  const shipped = Math.max(0, ...d.migrations())
  let applied: number | null = null
  const schema = engine === 'sqlite' ? { ok: true as const, skipped: 'sqlite' as const }
    : !store.ok ? { ok: false as const, ms: 0, reason: store.reason === 'timeout' ? 'timeout' as const : 'error' as const }
    : await timed('schema', async () => {
      const row = await db!.get<{ v: number | string | null }>('SELECT max(version) AS v FROM dazl_schema_migrations')
      applied = Number(row?.v ?? 0)
      return applied >= shipped ? 'ok' : 'behind'
    }, timeoutMs, clock)
  const sqlite = await timed('sqlite', async () => { d.sqlite().prepare('SELECT 1').get(); return 'ok' }, timeoutMs, clock)
  const raw = d.rawSqliteModules?.() ?? 0
  const split = engine === 'sqlite' ? { ok: true as const, skipped: 'sqlite' as const } : { ok: raw === 0, raw_sqlite_modules: raw }
  return {
    ok: store.ok && schema.ok && sqlite.ok && split.ok,
    store: { engine, migrations: { shipped, applied }, raw_sqlite_modules: raw },
    checks: { store: { ...store, engine }, schema, sqlite, split },
  }
}
