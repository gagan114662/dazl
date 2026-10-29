import { NextResponse } from 'next/server'
import { cookieDomain } from './auth-google.ts'

// Responses of the Google sign-in routes. Each one depends on the request and on runtime configuration and may carry
// a one-time cookie, so none may be cached by the browser, a proxy or the framework.
export const OAUTH_COOKIE = 'dazl_oauth'
const cookieOpts = (base: string, maxAge: number, path: string) =>
  ({ httpOnly: true, secure: true, sameSite: 'lax' as const, maxAge, path, ...(cookieDomain(base) ? { domain: cookieDomain(base) } : {}) })

export function redirectNoStore(url: string | URL): NextResponse {
  const res = NextResponse.redirect(url)
  res.headers.set('cache-control', 'no-store, max-age=0')
  return res
}
// the one-time state cookie, readable only by the sign-in routes
export const setOauthCookie = (res: NextResponse, base: string, value: string) => res.cookies.set(OAUTH_COOKIE, value, cookieOpts(base, 600, '/api/auth'))
// cleared with the attributes it was set with, so the browser drops that same cookie
export const clearOauthCookie = (res: NextResponse, base: string) => res.cookies.set(OAUTH_COOKIE, '', cookieOpts(base, 0, '/api/auth'))
export const setSessionCookie = (res: NextResponse, base: string, value: string, maxAge: number) => res.cookies.set('dazl_session', value, cookieOpts(base, maxAge, '/'))
// Where the callback lands after a re-authentication started from Settings (only this one value is honoured).
export const RETURN_COOKIE = 'dazl_return'
export const setReturnCookie = (res: NextResponse, base: string) => res.cookies.set(RETURN_COOKIE, 'settings', cookieOpts(base, 600, '/api/auth'))
export const clearReturnCookie = (res: NextResponse, base: string) => res.cookies.set(RETURN_COOKIE, '', cookieOpts(base, 0, '/api/auth'))
