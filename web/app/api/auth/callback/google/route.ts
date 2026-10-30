import { connection, NextRequest } from 'next/server'
import { createSession, SESSION_TTL_S } from '@/lib/auth-db'
import { getDb } from '@/lib/db/client'
import { exchangeCode, parseCookie, resolveUser, sameString, signInConfig, verifyIdToken } from '@/lib/auth-google'
import { clearNextCookie, clearOauthCookie, NEXT_COOKIE, OAUTH_COOKIE, redirectNoStore, setSessionCookie } from '@/lib/auth-google-response'
import { safeReturnTo, withReturnTo } from '@/lib/return-to'
import { clientIp, rateLimit } from '@/lib/rate-limit'

// A failure goes back to sign-in with the reason, keeping where the user was going (#416).
const back = (base: string, err: string, next: string | null = null) => {
  const res = redirectNoStore(new URL(withReturnTo(`/sign-in?error=${err}`, next), base))
  clearOauthCookie(res, base); clearNextCookie(res, base)
  return res
}

export async function GET(req: NextRequest) {
  // request time only: never prerendered with the build's configuration (lib/auth-google.ts signInConfig)
  await connection()
  const cfg = signInConfig()
  if (!cfg) return redirectNoStore(new URL('/sign-in?error=google_unavailable', process.env.PUBLIC_BASE_URL || req.url))
  const { base, clientId, clientSecret, redirectUri } = cfg
  const next = safeReturnTo(req.cookies.get(NEXT_COOKIE)?.value)
  const rl = await rateLimit(`google-cb:${clientIp(req)}`, 20, 10 * 60 * 1000)
  if (!rl.ok) return back(base, rl.unavailable ? 'unavailable' : 'too_many', next)

  const c = parseCookie(req.cookies.get(OAUTH_COOKIE)?.value)
  const q = req.nextUrl.searchParams
  const code = q.get('code') ?? '', state = q.get('state') ?? ''
  if (!c || q.get('error') || !code || !state || !sameString(state, c.state)) return back(base, 'google_failed', next)

  const idToken = await exchangeCode(code, { clientId, clientSecret, redirectUri, verifier: c.verifier })
  if (!idToken) return back(base, 'google_failed', next)
  const id = await verifyIdToken(idToken, { clientId, nonce: c.nonce })
  if (typeof id === 'string') return back(base, id === 'email_not_verified' ? 'google_email_unverified' : 'google_failed', next)

  const db = await getDb()
  const r = await resolveUser(db, id)
  if ('error' in r) return back(base, 'google_email_exists', next)

  const res = redirectNoStore(new URL(next ?? '/app', base))
  setSessionCookie(res, base, await createSession(r.user_id), SESSION_TTL_S)
  clearOauthCookie(res, base); clearNextCookie(res, base)
  return res
}
