// Liveness and readiness (docs/PLATFORM.md step 6).
// Liveness: the process answers. No dependency is touched, so a slow database never gets a healthy process restarted.
// Readiness: this instance can serve: the store answers (Postgres when DATABASE_URL is set, else SQLite), its schema
// has every migration this build ships (Postgres), and the SQLite file the raw-handle modules still use answers.
// Each check has its own timeout. The response names which check failed, never why: the error itself goes to
// captureError (stderr / alert hook), since /api/health is public.
import type { Db } from '../db/client.ts'
import { captureError } from './errors.ts'

export type CheckResult = { ok: true; ms: number } | { ok: false; ms: number; reason: 'error' | 'timeout' | 'behind' }
export interface Readiness {
  ok: boolean
  checks: { store: CheckResult & { engine: Db['kind'] | 'unknown' }; schema: CheckResult | { ok: true; skipped: 'sqlite' }; sqlite: CheckResult }
}

export interface ReadinessDeps {
  db: () => Promise<Db>
  sqlite: () => { prepare(sql: string): { get(): unknown } }
  // versions of the PG migrations this build ships (lib/db/migrations/pg)
  migrations: () => number[]
  timeoutMs?: number
  clock?: () => number
}

class Timeout extends Error { constructor() { super('readiness check timed out'); this.name = 'Timeout' } }

async function timed(name: string, f: () => Promise<'ok' | 'behind'>, timeoutMs: number, clock: () => number): Promise<CheckResult> {
  const t0 = clock()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const r = await Promise.race([f(), new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Timeout()), timeoutMs) })])
    return r === 'ok' ? { ok: true, ms: clock() - t0 } : { ok: false, ms: clock() - t0, reason: 'behind' }
  } catch (e) {
    captureError(e, { source: 'health', where: `readiness:${name}` })
    return { ok: false, ms: clock() - t0, reason: e instanceof Timeout ? 'timeout' : 'error' }
  } finally { clearTimeout(timer) }
}

export async function readiness(d: ReadinessDeps): Promise<Readiness> {
  const timeoutMs = d.timeoutMs ?? 2000, clock = d.clock ?? Date.now
  let db: Db | undefined
  const store = await timed('store', async () => { db = await d.db(); await db.get('SELECT 1 AS x'); return 'ok' }, timeoutMs, clock)
  const engine = db?.kind ?? 'unknown'
  const schema = engine === 'sqlite' ? { ok: true as const, skipped: 'sqlite' as const }
    : !store.ok ? { ok: false as const, ms: 0, reason: store.reason === 'timeout' ? 'timeout' as const : 'error' as const }
    : await timed('schema', async () => {
      const want = Math.max(0, ...d.migrations())
      const row = await db!.get<{ v: number | string | null }>('SELECT max(version) AS v FROM dazl_schema_migrations')
      return Number(row?.v ?? 0) >= want ? 'ok' : 'behind'
    }, timeoutMs, clock)
  const sqlite = await timed('sqlite', async () => { d.sqlite().prepare('SELECT 1').get(); return 'ok' }, timeoutMs, clock)
  return { ok: store.ok && schema.ok && sqlite.ok, checks: { store: { ...store, engine }, schema, sqlite } }
}
