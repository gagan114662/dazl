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
// #416: where to go after Google sign-in (an /app path, checked again when read), kept beside the state cookie
export const NEXT_COOKIE = 'dazl_oauth_next'
export const setNextCookie = (res: NextResponse, base: string, value: string) => res.cookies.set(NEXT_COOKIE, value, cookieOpts(base, 600, '/api/auth'))
export const clearNextCookie = (res: NextResponse, base: string) => res.cookies.set(NEXT_COOKIE, '', cookieOpts(base, 0, '/api/auth'))
