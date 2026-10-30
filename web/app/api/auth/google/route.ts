import { connection, NextRequest } from 'next/server'
import { signInConfig, startAuth } from '@/lib/auth-google'
import { clearNextCookie, redirectNoStore, setNextCookie, setOauthCookie } from '@/lib/auth-google-response'
import { safeReturnTo, withReturnTo } from '@/lib/return-to'
import { clientIp, rateLimit } from '@/lib/rate-limit'

export async function GET(req: NextRequest) {
  // request time only: never prerendered with the build's configuration (lib/auth-google.ts signInConfig)
  await connection()
  const cfg = signInConfig()
  const next = safeReturnTo(req.nextUrl.searchParams.get('next'))
  if (!cfg) return redirectNoStore(new URL(withReturnTo('/sign-in?error=google_unavailable', next), process.env.PUBLIC_BASE_URL || req.url))
  const rl = (await rateLimit(`google:${clientIp(req)}`, 20, 10 * 60 * 1000))
  if (!rl.ok) return redirectNoStore(new URL(withReturnTo(`/sign-in?error=${rl.unavailable ? 'unavailable' : 'too_many'}`, next), cfg.base))
  const { url, cookie } = startAuth(cfg.clientId, cfg.redirectUri)
  const res = redirectNoStore(url)
  setOauthCookie(res, cfg.base, cookie)
  if (next) setNextCookie(res, cfg.base, next); else clearNextCookie(res, cfg.base)
  return res
}
