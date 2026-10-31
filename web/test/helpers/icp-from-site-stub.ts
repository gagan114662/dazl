// Stand-in for lib/scan/icp-from-site.ts in the site-read route runtime: the page counts as fetched and readable, so the
// route's trial admission runs exactly where the real read would run it. An admitted read records the key it was handed
// and then fails as a trial read would; nothing is fetched or called.
// `next.error` makes the next read end with that typed error before any admission (an own-key read refused by the
// owner's spend pool, 'spend_limit'; a trial read that failed, 'trial_read_failed'), so the route's mapping of each is
// checked on the real handler.
import type { SiteReadAdmission, SiteReadRefusal } from '../../lib/scan/trial-site-read.ts'
export const handedKeys: string[] = []
export const next: { error: string | null } = { error: null }
export async function icpFromWebsite(_db: unknown, _tenantId: string, _url: string, deps: { trial?: () => Promise<SiteReadAdmission> }): Promise<{ error: string; trial?: SiteReadRefusal }> {
  if (next.error) { const error = next.error; next.error = null; return { error } }
  if (!deps.trial) return { error: 'no_api_key' }
  const a = await deps.trial()
  if (!a.ok) return { error: 'no_api_key', trial: a.reason }
  handedKeys.push(a.key.key)
  return { error: 'trial_read_failed' }
}
