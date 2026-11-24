// The session cookie in the browser (#1686). Google sign-in used to set dazl_session for the parent domain (Domain=.dazl.ai) while a
// password sign-in set it for the host only. A browser keeps those as two separate cookies, so one browser could hold two accounts'
// sessions at once: the server read whichever came first, and Sign out removed only the host-only one.
// The rule now:
//   - every sign-in sets the host-only cookie (lib/auth-google-response.ts setSessionCookie no longer sets a Domain), so new
//     sign-ins can only replace one another;
//   - a browser still carrying a parent-domain cookie from before, next to a host-only one, has the old one removed on its next
//     page load (proxy.ts), so the most recent sign-in is the one that stays;
//   - Sign out ends every session the browser presented.
// No response ever carries two Set-Cookie lines for dazl_session: Next merges the cookies a route sets by NAME and would keep one.
import { cookieDomain } from './auth-google.ts'

export const SESSION_COOKIE = 'dazl_session'
// set with the redirect that removes the old cookie, so a browser whose old cookie cannot be removed is not redirected again
export const SESSION_FIX_COOKIE = 'dazl_session_fix'

// Every dazl_session value in a Cookie header, in the order sent, each once.
export function sessionTokens(cookieHeader: string | null | undefined): string[] {
  const out: string[] = []
  for (const part of (cookieHeader ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0 || part.slice(0, i).trim() !== SESSION_COOKIE) continue
    let v = part.slice(i + 1).trim()
    try { v = decodeURIComponent(v) } catch { /* keep the raw value */ }
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

// The Set-Cookie line that removes the parent-domain form of the session cookie, or null where the site has none (localhost, an IP address).
export function oldDomainSessionExpiry(base: string): string | null {
  const d = cookieDomain(base)
  return d ? `${SESSION_COOKIE}=; Domain=${d}; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; Secure; SameSite=Lax` : null
}

// Whether this page request should be answered with that removal: it carries more than one session, the site has a parent-domain
// form to remove, and this browser was not already sent the removal in the last minute.
export function shouldDropOldSessionCookie(cookieHeader: string | null | undefined, method: string, base: string | undefined): boolean {
  if (!base || (method !== 'GET' && method !== 'HEAD')) return false
  if (sessionTokens(cookieHeader).length < 2 || !oldDomainSessionExpiry(base)) return false
  return !(cookieHeader ?? '').split(';').some(p => p.trim().startsWith(`${SESSION_FIX_COOKIE}=`))
}
