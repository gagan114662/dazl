import { hasLiveSession } from './auth-db.ts'
import type { Db } from './db/client.ts'

// The /app layout's session check (app/app/layout.tsx AuthGate) streams behind the "Opening your workspace…"
// Suspense fallback. If any step never settles (opening the store, the lookup), that fallback stayed on screen
// forever with no error and no log (prod c52df79, 2026-11-21 ~9:05am). Each step now has a deadline: past it the
// check throws SessionCheckTimeout naming the step that stalled, so the page shows the error boundary (Reload /
// Try again) and the server log says where it stuck. A slow but finished check is logged with its step timings.
export const SESSION_CHECK_MS = 8000
export const SLOW_SESSION_CHECK_MS = 1000

export type GateStep = 'open_store' | 'lookup'

export class SessionCheckTimeout extends Error {
  step: GateStep
  ms: number
  constructor(step: GateStep, ms: number) { super(`session check stalled at ${step} after ${ms}ms`); this.step = step; this.ms = ms }
}

export type GateDeps = { getDb: () => Promise<Db>; ms?: number; now?: () => number; log?: (line: string) => void }

function within<T>(p: Promise<T>, step: GateStep, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SessionCheckTimeout(step, ms)), ms) })
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer))
}

export async function checkSessionWithin(token: string | undefined, deps: GateDeps): Promise<boolean> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return false
  const ms = deps.ms ?? SESSION_CHECK_MS
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((l: string) => console.log(l))
  const t0 = now()
  try {
    const db = await within(deps.getDb(), 'open_store', ms)
    const t1 = now()
    const live = await within(hasLiveSession(token, db), 'lookup', ms)
    const total = now() - t0
    if (total >= SLOW_SESSION_CHECK_MS) log(JSON.stringify({ level: 'warn', type: 'auth_gate_slow', open_store_ms: t1 - t0, lookup_ms: now() - t1, total_ms: total }))
    return live
  } catch (e) {
    if (e instanceof SessionCheckTimeout) log(JSON.stringify({ level: 'error', type: 'auth_gate_stalled', step: e.step, ms: e.ms }))
    throw e
  }
}
