// One hostname for pages (#1686, review of PR #1688). The site answers on its own hostname and on www.<hostname>. A session cookie
// set for one host only (a password sign-in) is not sent to the other, so a person could be signed in as one account on www and as
// another on the bare hostname, and a sign-in on one could not remove the other's cookie. A page asked for on www is sent to the
// same path on the site's own hostname (PUBLIC_BASE_URL), so sessions are only ever set and read there. API calls are left alone:
// a page already open on www posts to its own origin, and a redirect to another origin would fail in the browser.
export function canonicalPageUrl(host: string | null | undefined, pathAndQuery: string, method: string, base: string | undefined): string | null {
  if (!host || !base || (method !== 'GET' && method !== 'HEAD')) return null
  let b: URL
  try { b = new URL(base) } catch { return null }
  if (host.toLowerCase().replace(/:\d+$/, '') !== `www.${b.hostname}`) return null
  const path = pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`
  if (path.startsWith('/api/') || path.startsWith('/_next/')) return null
  return `${b.origin}${path}`
}
