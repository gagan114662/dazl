import { connection, NextRequest } from 'next/server'
import { createSession, getSessionUser, replacedSession, SESSION_TTL_S } from '@/lib/auth-db'
import { FRESH_AUTH_S } from '@/lib/sessions'
import { getDb } from '@/lib/db/client'
import { exchangeCode, linkGoogle, parseCookie, resolveUser, sameString, signInConfig, verifyIdToken } from '@/lib/auth-google'
import { clearOauthCookie, clearReturnCookie, OAUTH_COOKIE, redirectNoStore, RETURN_COOKIE, setSessionCookie } from '@/lib/auth-google-response'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { deviceLabel } from '@/lib/sessions'

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
  if (req.cookies.get(RETURN_COOKIE)?.value === 'link') {
    // Linking: only for the account signed in on this browser, signed in within the last hour; lib/auth-google.ts
    // linkGoogle checks the verified, matching email. The session is kept; no new one is made.
    const me = await getSessionUser(req.cookies.get('dazl_session')?.value, db)
    const fresh = !!me && Math.floor(Date.now() / 1000) - me.authedAt <= FRESH_AUTH_S
    const result = !me ? 'signed_out' : !fresh ? 'reauth_required' : await linkGoogle(db, me.actorId, id, req.cookies.get('dazl_session')!.value)
    const res = redirectNoStore(new URL(`/app/settings?google=${result}#account`, base))
    clearOauthCookie(res, base)
    clearReturnCookie(res, base)
    return res
  }
  const r = await resolveUser(db, id)
  if ('error' in r) return back(base, 'google_email_exists')

  // Signing in again on a browser already signed in to this same account (a re-authentication) replaces that session
  // rather than leaving it behind; another account's session in the cookie is left alone.
  await replacedSession(req.cookies.get('dazl_session')?.value, r.user_id, db)
  const landing = req.cookies.get(RETURN_COOKIE)?.value === 'settings' ? '/app/settings' : '/app'
  const res = redirectNoStore(new URL(landing, base))
  setSessionCookie(res, base, await createSession(r.user_id, undefined, { device: deviceLabel(req.headers.get('user-agent')) }), SESSION_TTL_S)
  clearOauthCookie(res, base)
  clearReturnCookie(res, base)
  return res
}
