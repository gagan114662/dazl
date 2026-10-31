// Stand-in for lib/scan/icp-from-site.ts in the site-read route runtime: the page counts as fetched and readable, so the
// route's trial admission runs exactly where the real read would run it. An admitted read records the key it was handed
// and then fails as a trial read would: by default as the read's own guard refusing before any call (released: nothing
// spent), or with `next.outcome = 'call_failed'` as a provider error after a call (settled at the full reserve), exactly
// what the real module does on each path. Nothing is fetched or called.
// `next.error` makes the next read end with that typed error before any admission (an own-key read refused by the
// owner's spend pool, 'spend_limit'; 'key_unreadable'; ...), so the route's mapping of each is checked on the real handler.
import type { SiteReadAdmission, SiteReadRefusal } from '../../lib/scan/trial-site-read.ts'
export const handedKeys: string[] = []
export const calls = { n: 0 }
export const next: { error: string | null; outcome: 'guard_refused' | 'call_failed' } = { error: null, outcome: 'guard_refused' }
export async function icpFromWebsite(_db: unknown, _tenantId: string, _url: string, deps: { trial?: () => Promise<SiteReadAdmission> }): Promise<{ error: string; trial?: SiteReadRefusal }> {
  calls.n++
  if (next.error) { const error = next.error; next.error = null; return { error } }
  if (!deps.trial) return { error: 'no_api_key' }
  const a = await deps.trial()
  if (!a.ok) return { error: 'no_api_key', trial: a.reason }
  handedKeys.push(a.key.key)
  if (next.outcome === 'call_failed') { next.outcome = 'guard_refused'; await a.settle(null) } else await a.release()
  return { error: 'trial_read_failed' }
}
