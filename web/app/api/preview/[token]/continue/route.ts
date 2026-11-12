import { connection, NextRequest } from 'next/server'
import { getDb } from '@/lib/db/client'
import { getMasterKey } from '@/lib/secrets'
import { isClaimToken, readPublicClaim } from '@/lib/scan/preview-claim'
import { redirectNoStore, setClaimCookie } from '@/lib/auth-google-response'
import { clientIp, rateLimit } from '@/lib/rate-limit'

// Continue a preview claim with a password: "Create account" / "Sign in" on the public preview page (#416). Like the
// Google start next door, the intent cookie is set only from a validated, live preview row. It is what lets the claim
// survive the email confirmation round trip: the confirmation link usually opens in a NEW tab, where the tab-only
// sessionStorage copy is gone, and the sign-in route then resumes from this cookie. The destination is one of two fixed
// pages; no input URL is ever redirected to.
const PAGES = { 'sign-up': '/sign-up', 'sign-in': '/sign-in' } as const

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  await connection()
  const base = process.env.PUBLIC_BASE_URL || req.url
  const { token } = await ctx.params
  const to = req.nextUrl.searchParams.get('to')
  const page = to === 'sign-up' || to === 'sign-in' ? PAGES[to] : PAGES['sign-in']
  if (!isClaimToken(token)) return redirectNoStore(new URL('/sign-in', base))
  const rl = await rateLimit(`preview-continue:${clientIp(req)}`, 20, 10 * 60 * 1000)
  if (!rl.ok) return redirectNoStore(new URL(`/preview/${token}?e=too_many`, base))
  const c = await readPublicClaim(await getDb(), getMasterKey(), token)
  if (c.status !== 'ok') return redirectNoStore(new URL(`/preview/${token}`, base))
  const res = redirectNoStore(new URL(page, base))
  setClaimCookie(res, token)
  return res
}
