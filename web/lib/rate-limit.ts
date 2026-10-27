// Fixed-window rate limiter shared by every app instance: the counter lives in the rate_limits table, and each check is
// one atomic upsert (works the same on SQLite and Postgres), so limits survive restarts and hold across instances.
// If the store cannot answer, the per-process limiter below takes over: protection is never removed.
import { getDb } from './db/client.ts'
import type { Db } from './db/client.ts'

export interface Limit { ok: boolean; retryAfterS: number }

let calls = 0

// Per-process fallback, the limiter this app ran before the shared one. Used only when the shared store cannot answer,
// so a store outage (read-only, full disk, locked, unreachable) never removes protection: each instance still enforces
// the limit on its own traffic, exactly as it did before limits were shared.
const local = new Map<string, { count: number; resetAt: number }>()
function localLimit(key: string, limit: number, windowMs: number, now: number): Limit {
  if (local.size > 10_000) for (const [k, b] of local) if (b.resetAt <= now) local.delete(k)
  const b = local.get(key)
  if (!b || b.resetAt <= now) { local.set(key, { count: 1, resetAt: now + windowMs }); return { ok: true, retryAfterS: 0 } }
  b.count++
  return b.count <= limit ? { ok: true, retryAfterS: 0 } : { ok: false, retryAfterS: Math.ceil((b.resetAt - now) / 1000) }
}

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
    return localLimit(k, limit, windowMs, now)
  }
  // Expired windows are dead rows; sweep them now and then instead of on every call. A failed sweep changes nothing.
  if (++calls % 500 === 0) await db.run('DELETE FROM rate_limits WHERE reset_at <= ?', [now]).catch(() => {})
  const count = Number(r.count), resetAt = Number(r.reset_at)
  return { ok: count <= limit, retryAfterS: count <= limit ? 0 : Math.ceil((resetAt - now) / 1000) }
}

export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for')
  return (xff ? xff.split(',')[0] : req.headers.get('x-real-ip') || 'unknown').trim()
}
