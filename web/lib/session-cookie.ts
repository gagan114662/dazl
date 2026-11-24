// The session cookie in the browser (#1686). Google sign-in sets dazl_session for the parent domain (lib/auth-google.ts cookieDomain:
// the sign-in can start on www and finish on the apex), while a password sign-in or sign-up sets it for the host only. A browser
// keeps those as two separate cookies, so one browser could hold two accounts' sessions at once: the app showed one account in one
// place and the other elsewhere, and Sign out removed only the host-only one, leaving the person signed in as the other account.
// The rule now: setting the cookie in one form removes the other form, and signing out removes both and ends every session the
// browser presented.
import { cookieDomain } from './auth-google.ts'

export const SESSION_COOKIE = 'dazl_session'
const EXPIRED = 'Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; Secure; SameSite=Lax'

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

// The Set-Cookie lines that remove the session cookie: its host-only form, its parent-domain form, or both. Where the site has no
// parent-domain form (localhost, an IP address) every sign-in sets the one host-only cookie, so there is no "other form" to remove:
// 'host' and 'domain' give nothing there (review of PR #1688: removing 'host' after a Google sign-in on localhost removed the very
// session it had just set), and 'both' (signing out) gives the host-only line.
export function expiredSessionCookies(base: string, which: 'host' | 'domain' | 'both'): string[] {
  const d = cookieDomain(base)
  if (!d) return which === 'both' ? [`${SESSION_COOKIE}=; ${EXPIRED}`] : []
  return [...(which !== 'domain' ? [`${SESSION_COOKIE}=; ${EXPIRED}`] : []), ...(which !== 'host' ? [`${SESSION_COOKIE}=; Domain=${d}; ${EXPIRED}`] : [])]
}

// Adds those lines to a response. Call it last: setting another cookie through the response's cookie API afterwards rewrites the
// Set-Cookie headers and would drop these.
export function expireSessionCookies<T extends { headers: Headers }>(res: T, base: string, which: 'host' | 'domain' | 'both'): T {
  for (const c of expiredSessionCookies(base, which)) res.headers.append('set-cookie', c)
  return res
}
