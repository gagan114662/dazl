// Fixed-window rate limiter shared by every app instance: the counter lives in the rate_limits table, and each check is
// one atomic upsert (works the same on SQLite and Postgres), so limits survive restarts and hold across instances.
// If the store cannot answer, the per-process shadow below takes over: protection is never removed or reset.
import { getDb } from './db/client.ts'
import type { Db } from './db/client.ts'

export interface Limit { ok: boolean; retryAfterS: number }

let calls = 0

// Per-process shadow of every key this process has counted, so a store outage never hands back an allowance:
//   seen    - the highest shared count this process has been told for the current window
//   offline - calls this process decided on its own while the store could not answer (they never reached the store)
// The decision is the shared count (or `seen` when the store is down) plus `offline`. When the store is healthy that is
// exactly the shared count; across an outage, a recovery, or the store flipping between the two, it still counts every
// call of the window. During an outage each instance enforces the limit on the traffic it sees, as before limits were
// shared.
const local = new Map<string, { seen: number; offline: number; resetAt: number }>()
function bucket(key: string, now: number) {
  if (local.size > 10_000) for (const [k, b] of local) if (b.resetAt <= now) local.delete(k)
  const b = local.get(key)
  return b && b.resetAt > now ? b : undefined
}
const decide = (count: number, resetAt: number, limit: number, now: number): Limit =>
  count <= limit ? { ok: true, retryAfterS: 0 } : { ok: false, retryAfterS: Math.ceil((resetAt - now) / 1000) }

export async function rateLimit(key: string, limit: number, windowMs: number, d?: Db, now = Date.now()): Promise<Limit> {
  const k = key.slice(0, 300)
  let r: { count: number; reset_at: number } | undefined
  let db: Db | undefined
  try {
    db = d ?? await getDb()
    r = await db.get<{ count: number; reset_at: number }>(
      `INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= ? THEN ? ELSE rate_limits.reset_at END
       RETURNING count, reset_at`,
      [k, now + windowMs, now, now, now + windowMs])
    if (!r) throw new Error('rate limit upsert returned no row')
  } catch (e) {
    console.error('shared rate limit store unavailable; enforcing this process\'s own limit', key.split(':')[0], e instanceof Error ? e.message : e)
    const b = bucket(k, now) ?? { seen: 0, offline: 0, resetAt: now + windowMs }
    b.offline++
    local.set(k, b)
    return decide(b.seen + b.offline, b.resetAt, limit, now)
  }
  // Expired windows are dead rows; sweep them now and then instead of on every call. A failed sweep changes nothing.
  if (++calls % 500 === 0) await db.run('DELETE FROM rate_limits WHERE reset_at <= ?', [now]).catch(() => {})
  const shared = Number(r.count), sharedReset = Number(r.reset_at)
  // While this process's window for the key is open, its offline calls keep counting, even if the shared row has
  // started a window of its own meanwhile (the outage began first); a fresh shadow starts only once that window is over.
  let b = bucket(k, now)
  if (!b) { b = { seen: 0, offline: 0, resetAt: sharedReset }; local.set(k, b) }
  b.resetAt = Math.max(b.resetAt, sharedReset)
  b.seen = Math.max(b.seen, shared)
  return decide(shared + b.offline, b.resetAt, limit, now)
}

export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for')
  return (xff ? xff.split(',')[0] : req.headers.get('x-real-ip') || 'unknown').trim()
}
