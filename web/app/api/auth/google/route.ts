import { NextRequest, NextResponse } from 'next/server'
import { cookieDomain, startAuth } from '@/lib/auth-google'
import { clientIp, rateLimit } from '@/lib/rate-limit'

export async function GET(req: NextRequest) {
  const base = process.env.PUBLIC_BASE_URL
  const clientId = process.env.GOOGLE_CLIENT_ID
  if (!base || !clientId || !process.env.GOOGLE_CLIENT_SECRET) return NextResponse.redirect(new URL('/sign-in?error=google_unavailable', base || req.url))
  const rl = rateLimit(`google:${clientIp(req)}`, 20, 10 * 60 * 1000)
  if (!rl.ok) return NextResponse.redirect(new URL('/sign-in?error=too_many', base))
  const { url, cookie } = startAuth(clientId, `${base.replace(/\/$/, '')}/api/auth/callback/google`)
  const res = NextResponse.redirect(url)
  res.cookies.set('dazl_oauth', cookie, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 600, path: '/api/auth', ...(cookieDomain(base) ? { domain: cookieDomain(base) } : {}) })
  return res
}
