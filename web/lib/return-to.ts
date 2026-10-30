// #416: where to go after sign-in or sign-up. Only a path inside the app on this same site is ever followed, so a
// crafted link cannot send a freshly signed-in user anywhere else (open redirect): no scheme, no host, no "//" or "\",
// no control characters, and after the browser's own normalisation ("..", "%2e") the path must still be /app or under
// it. Pure and client-safe; used by the sign-in pages, the Google callback and the /app gate.
const MAX = 512
const PROBE = 'https://return-to.invalid'

export function safeReturnTo(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX) return null
  if (!raw.startsWith('/') || raw.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(raw)) return null
  let u: URL
  try { u = new URL(raw, PROBE) } catch { return null }
  if (u.origin !== PROBE) return null
  if (u.pathname !== '/app' && !u.pathname.startsWith('/app/')) return null
  return u.pathname + u.search
}

// The sign-in or sign-up page link that carries a safe destination along (dropped when it is not safe).
export const withReturnTo = (page: string, next: unknown): string => {
  const n = safeReturnTo(next)
  return n ? `${page}${page.includes('?') ? '&' : '?'}next=${encodeURIComponent(n)}` : page
}
