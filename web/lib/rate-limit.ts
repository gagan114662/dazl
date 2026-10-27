// Fixed-window rate limiter shared by every app instance: the counter lives in the rate_limits table, and each check is
// one atomic upsert (works the same on SQLite and Postgres), so limits survive restarts and hold across instances.
import { getDb } from './db/client.ts'
import type { Db } from './db/client.ts'

export interface Limit { ok: boolean; retryAfterS: number }

let calls = 0

export async function rateLimit(key: string, limit: number, windowMs: number, d?: Db, now = Date.now()): Promise<Limit> {
  const k = key.slice(0, 300)
  try {
    const db = d ?? await getDb()
    const r = await db.get<{ count: number; reset_at: number }>(
      `INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= ? THEN ? ELSE rate_limits.reset_at END
       RETURNING count, reset_at`,
      [k, now + windowMs, now, now, now + windowMs])
    // Expired windows are dead rows; sweep them now and then instead of on every call.
    if (++calls % 500 === 0) await db.run('DELETE FROM rate_limits WHERE reset_at <= ?', [now])
    const count = Number(r!.count), resetAt = Number(r!.reset_at)
    return { ok: count <= limit, retryAfterS: count <= limit ? 0 : Math.ceil((resetAt - now) / 1000) }
  } catch (e) {
    // The store being down already breaks every request that needs it; refusing all traffic here would only add an
    // outage on top. Fail open and say so loudly.
    console.error('rate limit store unavailable; allowing request', key.split(':')[0], e instanceof Error ? e.message : e)
    return { ok: true, retryAfterS: 0 }
  }
}
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for')
  return (xff ? xff.split(',')[0] : req.headers.get('x-real-ip') || 'unknown').trim()
}
