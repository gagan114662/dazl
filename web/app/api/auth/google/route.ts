import { connection, NextRequest } from 'next/server'
import { signInConfig, startAuth } from '@/lib/auth-google'
import { redirectNoStore, setOauthCookie } from '@/lib/auth-google-response'
import { clientIp, rateLimit } from '@/lib/rate-limit'

export async function GET(req: NextRequest) {
  // request time only: never prerendered with the build's configuration (lib/auth-google.ts signInConfig)
  await connection()
  const cfg = signInConfig()
  if (!cfg) return redirectNoStore(new URL('/sign-in?error=google_unavailable', process.env.PUBLIC_BASE_URL || req.url))
  const rl = (await rateLimit(`google:${clientIp(req)}`, 20, 10 * 60 * 1000))
  if (!rl.ok) return redirectNoStore(new URL('/sign-in?error=too_many', cfg.base))
  const { url, cookie } = startAuth(cfg.clientId, cfg.redirectUri)
  const res = redirectNoStore(url)
  setOauthCookie(res, cfg.base, cookie)
  return res
}
