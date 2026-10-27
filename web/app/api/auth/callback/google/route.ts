import { NextRequest, NextResponse } from 'next/server'
import { createSession, getAuthDb, SESSION_TTL_S } from '@/lib/auth-db'
import { getDb } from '@/lib/db/client'
import { cookieDomain, exchangeCode, migrateOauth, parseCookie, resolveUser, sameString, verifyIdToken } from '@/lib/auth-google'
import { clientIp, rateLimit } from '@/lib/rate-limit'

const back = (base: string, err: string) => {
  const res = NextResponse.redirect(new URL(`/sign-in?error=${err}`, base))
  res.cookies.set('dazl_oauth', '', { maxAge: 0, path: '/api/auth', ...(cookieDomain(base) ? { domain: cookieDomain(base) } : {}) })
  return res
}

export async function GET(req: NextRequest) {
  const base = process.env.PUBLIC_BASE_URL
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!base || !clientId || !clientSecret) return NextResponse.redirect(new URL('/sign-in?error=google_unavailable', base || req.url))
  if (!rateLimit(`google-cb:${clientIp(req)}`, 20, 10 * 60 * 1000).ok) return back(base, 'too_many')

  const c = parseCookie(req.cookies.get('dazl_oauth')?.value)
  const q = req.nextUrl.searchParams
  const code = q.get('code') ?? '', state = q.get('state') ?? ''
  if (!c || q.get('error') || !code || !state || !sameString(state, c.state)) return back(base, 'google_failed')

  const redirectUri = `${base.replace(/\/$/, '')}/api/auth/callback/google`
  const idToken = await exchangeCode(code, { clientId, clientSecret, redirectUri, verifier: c.verifier })
  if (!idToken) return back(base, 'google_failed')
  const id = await verifyIdToken(idToken, { clientId, nonce: c.nonce })
  if (typeof id === 'string') return back(base, id === 'email_not_verified' ? 'google_email_unverified' : 'google_failed')

  const db = await getDb()
  if (db.kind === 'sqlite') migrateOauth(getAuthDb())
  const r = await resolveUser(db, id)
  if ('error' in r) return back(base, 'google_email_exists')

  const res = NextResponse.redirect(new URL('/app', base))
  res.cookies.set('dazl_session', await createSession(r.user_id), { httpOnly: true, secure: true, sameSite: 'lax', maxAge: SESSION_TTL_S, path: '/', ...(cookieDomain(base) ? { domain: cookieDomain(base) } : {}) })
  res.cookies.set('dazl_oauth', '', { maxAge: 0, path: '/api/auth', ...(cookieDomain(base) ? { domain: cookieDomain(base) } : {}) })
  return res
}
