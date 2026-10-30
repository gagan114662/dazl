// Fixed-window rate limiter shared by every app instance: the counter lives in the rate_limits table, and each check is
// one atomic upsert (works the same on SQLite and Postgres), so limits survive restarts and hold across instances.
// If the store cannot answer, what happens depends on the key's kind (DEGRADED below): auth, trial and anything that
// spends a shared cost FAILS CLOSED (refused until the store answers again), because a per-process allowance multiplies
// with every instance and every restart. Only the deliberately low-risk kinds listed as 'local' fall back to the
// per-process shadow. Protection is never removed or reset.
import { getDb } from './db/client.ts'
import type { Db } from './db/client.ts'

// unavailable: refused only because the shared store could not answer (the caller may say so instead of "too many")
export interface Limit { ok: boolean; retryAfterS: number; unavailable?: true }

// What a key's kind does while the shared store cannot answer. Every rateLimit call site's kind is listed here
// (test/rate-limit-degraded.test.ts checks); a kind that is not listed fails closed.
//   closed - refused: sign-in, sign-up and Google sign-in (brute force across instances), scans and trial admission,
//            and every action that calls a paid or shared provider (models, search, enrichment, CRM, billing, Gmail
//            reads, indexing) or schedules one.
//   local  - this process's own limit, as before limits were shared: actions that stay inside the app's own data and
//            cost nothing shared, and actions that must keep working for the recipient or the tenant's safety
//            (unsubscribe, quarantine). Transactional sends stay 'local': their budgets (daily cap, per-tenant send
//            count) are enforced in the send path itself, unchanged.
export type Degraded = 'closed' | 'local'
export const DEGRADED: Record<string, Degraded> = {
  // auth
  'signin-ip': 'closed', 'signin-acct': 'closed', signup: 'closed', google: 'closed', 'google-cb': 'closed',
  // scans, trial admission and paid or shared providers
  scan: 'closed', icp: 'closed', icpurl: 'closed', qualify: 'closed', 'qualify-preview': 'closed', 'hiring-feed': 'closed',
  'hiring-feed-retry': 'closed', 'page-signals': 'closed', 'source-review': 'closed', 'find-contact': 'closed',
  'settings:enrichment': 'closed', polish: 'closed', seo: 'closed', 'seo-brief': 'closed', newsjack: 'closed',
  'seo-idx': 'closed', 'commenter-import': 'closed', 'csv-import': 'closed', 'csv-resume': 'closed', crm: 'closed',
  checkout: 'closed', llmkey: 'closed', sync: 'closed', 'replies-refresh': 'closed', adv: 'closed', watch: 'closed',
  // low risk: the app's own data, or must keep working
  'client-errors': 'local', unsub: 'local', 'confirm-lead': 'local', 'quarantine-lead': 'local', 'domain-review': 'local',
  'warm-report': 'local', 'warm-import': 'local', replies: 'local', profile: 'local', calcom: 'local', 'calcom-cfg': 'local',
  send: 'local', draft: 'local', reopen: 'local', sequences: 'local', 'ranking-fixture': 'local', 'verification-fixture': 'local',
}
// The kind of a key is the longest listed prefix followed by ':' (keys may hold IPv6 addresses or emails after it).
export function degradedPolicy(key: string): Degraded {
  let best = ''
  for (const kind of Object.keys(DEGRADED)) if (key.startsWith(`${kind}:`) && kind.length > best.length) best = kind
  return best ? DEGRADED[best] : 'closed'
}
// How long a caller refused for an unavailable store is told to wait before trying again.
export const UNAVAILABLE_RETRY_S = 30

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
    const kind = key.split(':')[0], why = e instanceof Error ? e.message : e
    if (degradedPolicy(k) === 'closed') {
      console.error('shared rate limit store unavailable; refusing (fails closed)', kind, why)
      return { ok: false, retryAfterS: UNAVAILABLE_RETRY_S, unavailable: true }
    }
    console.error('shared rate limit store unavailable; enforcing this process\'s own limit', kind, why)
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
