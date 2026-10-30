// Stand-in for lib/scan/icp-from-site.ts in the site-read route runtime: the page counts as fetched and readable, so the
// route's trial admission runs exactly where the real read would run it. An admitted read records the key it was handed
// and then fails as a trial read would; nothing is fetched or called.
import type { SiteReadAdmission, SiteReadRefusal } from '../../lib/scan/trial-site-read.ts'
export const handedKeys: string[] = []
export async function icpFromWebsite(_db: unknown, _tenantId: string, _url: string, deps: { trial?: () => Promise<SiteReadAdmission> }): Promise<{ error: string; trial?: SiteReadRefusal }> {
  if (!deps.trial) return { error: 'no_api_key' }
  const a = await deps.trial()
  if (!a.ok) return { error: 'no_api_key', trial: a.reason }
  handedKeys.push(a.key.key)
  return { error: 'trial_read_failed' }
}
