import { connection, NextRequest } from 'next/server'
import { createSession, SESSION_TTL_S } from '@/lib/auth-db'
import { getDb } from '@/lib/db/client'
import { exchangeCode, parseCookie, resolveUser, sameString, signInConfig, verifyIdToken } from '@/lib/auth-google'
import { clearOauthCookie, OAUTH_COOKIE, redirectNoStore, setSessionCookie } from '@/lib/auth-google-response'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { recordLifecycle } from '@/lib/outreach/lifecycle'
import { captureError } from '@/lib/ops/errors'

const back = (base: string, err: string) => {
  const res = redirectNoStore(new URL(`/sign-in?error=${err}`, base))
  clearOauthCookie(res, base)
  return res
}

export async function GET(req: NextRequest) {
  // request time only: never prerendered with the build's configuration (lib/auth-google.ts signInConfig)
  await connection()
  const cfg = signInConfig()
  if (!cfg) return redirectNoStore(new URL('/sign-in?error=google_unavailable', process.env.PUBLIC_BASE_URL || req.url))
  const { base, clientId, clientSecret, redirectUri } = cfg
  const rl = await rateLimit(`google-cb:${clientIp(req)}`, 20, 10 * 60 * 1000)
  if (!rl.ok) return back(base, rl.unavailable ? 'unavailable' : 'too_many')

  const c = parseCookie(req.cookies.get(OAUTH_COOKIE)?.value)
  const q = req.nextUrl.searchParams
  const code = q.get('code') ?? '', state = q.get('state') ?? ''
  if (!c || q.get('error') || !code || !state || !sameString(state, c.state)) return back(base, 'google_failed')

  const idToken = await exchangeCode(code, { clientId, clientSecret, redirectUri, verifier: c.verifier })
  if (!idToken) return back(base, 'google_failed')
  const id = await verifyIdToken(idToken, { clientId, nonce: c.nonce })
  if (typeof id === 'string') return back(base, id === 'email_not_verified' ? 'google_email_unverified' : 'google_failed')

  const db = await getDb()
  const r = await resolveUser(db, id)
  if ('error' in r) return back(base, 'google_email_exists')
  // #417: a new account from a prospect of dazl's own acquisition outreach leaves it (never fails the sign-in)
  if (r.created) try { await recordLifecycle(db, { kind: 'signup', email: id.email, eventId: `signup:${r.user_id}` }) } catch (e) { captureError(e, { source: 'route', where: '/api/auth/callback/google:lifecycle' }) }

  const res = redirectNoStore(new URL('/app', base))
  setSessionCookie(res, base, await createSession(r.user_id), SESSION_TTL_S)
  clearOauthCookie(res, base)
  return res
}
