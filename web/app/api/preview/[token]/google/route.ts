import { connection, NextRequest } from 'next/server'
import { getDb } from '@/lib/db/client'
import { getMasterKey } from '@/lib/secrets'
import { isClaimToken, readPublicClaim } from '@/lib/scan/preview-claim'
import { redirectNoStore, setClaimCookie, setReturnCookie } from '@/lib/auth-google-response'
import { clientIp, rateLimit } from '@/lib/rate-limit'

// Continue a preview claim with Google (#416). The intent cookies are set only from a validated, live preview row:
// a foreign, expired or unknown token never reaches Google from here, and no input URL is ever redirected to.
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  await connection()
  const base = process.env.PUBLIC_BASE_URL || req.url
  const { token } = await ctx.params
  if (!isClaimToken(token)) return redirectNoStore(new URL('/sign-in', base))
  const rl = await rateLimit(`preview-google:${clientIp(req)}`, 20, 10 * 60 * 1000)
  if (!rl.ok) return redirectNoStore(new URL(`/preview/${token}?e=too_many`, base))
  const c = await readPublicClaim(await getDb(), getMasterKey(), token)
  if (c.status !== 'ok') return redirectNoStore(new URL(`/preview/${token}`, base))
  const res = redirectNoStore(new URL('/api/auth/google', base))
  setReturnCookie(res, base, 'preview')
  setClaimCookie(res, token)
  return res
}
