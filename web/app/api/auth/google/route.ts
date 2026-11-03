import { connection, NextRequest } from 'next/server'
import { signInConfig, startAuth } from '@/lib/auth-google'
import { redirectNoStore, setOauthCookie, setReturnCookie } from '@/lib/auth-google-response'
import { clientIp, rateLimit } from '@/lib/rate-limit'

export async function GET(req: NextRequest) {
  // request time only: never prerendered with the build's configuration (lib/auth-google.ts signInConfig)
  await connection()
  const cfg = signInConfig()
  if (!cfg) return redirectNoStore(new URL('/sign-in?error=google_unavailable', process.env.PUBLIC_BASE_URL || req.url))
  const rl = (await rateLimit(`google:${clientIp(req)}`, 20, 10 * 60 * 1000))
  if (!rl.ok) return redirectNoStore(new URL(`/sign-in?error=${rl.unavailable ? 'unavailable' : 'too_many'}`, cfg.base))
  const { url, cookie } = startAuth(cfg.clientId, cfg.redirectUri)
  const res = redirectNoStore(url)
  setOauthCookie(res, cfg.base, cookie)
  // ?reauth=1: re-authenticating from Settings (fresh sign-in for secrets, billing, members); come back there
  if (req.nextUrl.searchParams.get('reauth') === '1') setReturnCookie(res, cfg.base)
  // ?link=1: add Google sign-in to the signed-in account (Settings > Account); the callback decides, never this route
  if (req.nextUrl.searchParams.get('link') === '1') setReturnCookie(res, cfg.base, 'link')
  return res
}
