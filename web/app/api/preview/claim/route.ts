import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { getMasterKey } from '@/lib/secrets'
import { claimPreview, isClaimToken } from '@/lib/scan/preview-claim'
import { sameOriginJson } from '@/lib/same-origin'
import { clientIp, rateLimit, UNAVAILABLE_RETRY_S } from '@/lib/rate-limit'
import { captureError } from '@/lib/ops/errors'
import { requestIdOf } from '@/lib/ops/request-log'

// Claim a preview for the signed-in account (#416). The write is atomic in claimPreview; a GET never consumes
// anything. Failure codes never say more than the public page already would.
export async function POST(req: NextRequest) {
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 403 })
  const rl = await rateLimit(`preview-claim:${clientIp(req)}`, 20, 10 * 60 * 1000)
  if (rl.unavailable) return NextResponse.json({ error: 'Briefly unavailable. Try again in a moment.', code: 'limits_unavailable' }, { status: 503, headers: { 'Retry-After': String(UNAVAILABLE_RETRY_S) } })
  if (!rl.ok) return NextResponse.json({ error: 'Too many attempts. Try again later.', code: 'too_many' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterS) } })
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in', code: 'signed_out' }, { status: 401 })
  const body = await req.json().catch(() => null)
  const token = body?.token
  if (!isClaimToken(token)) return NextResponse.json({ error: 'This preview link is not valid.', code: 'unknown' }, { status: 404 })
  try {
    const c = await claimPreview(await getDb(), getMasterKey(), token, { actorId: user.actorId, tenantId: user.tenantId })
    if (c.status === 'claimed' || c.status === 'already') return NextResponse.json({ ok: true, id: c.id })
    if (c.status === 'unverified') return NextResponse.json({ error: 'Verify your email address to claim this preview.', code: 'unverified' }, { status: 403 })
    if (c.status === 'expired') return NextResponse.json({ error: 'This preview has expired.', code: 'expired' }, { status: 410 })
    if (c.status === 'foreign') return NextResponse.json({ error: 'This preview was made for a different account.', code: 'foreign' }, { status: 403 })
    return NextResponse.json({ error: 'This preview link is not valid.', code: 'unknown' }, { status: 404 })
  } catch (e) {
    captureError(e, { source: 'route', where: '/api/preview/claim', method: 'POST', requestId: requestIdOf(req) })
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 })
  }
}
