import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { getMasterKey } from '@/lib/secrets'
import { claimPreview, isClaimToken, readPublicClaim } from '@/lib/scan/preview-claim'
import { clearClaimCookie, PREVIEW_CLAIM_COOKIE } from '@/lib/auth-google-response'
import { sameOriginJson } from '@/lib/same-origin'
import { clientIp, rateLimit, UNAVAILABLE_RETRY_S } from '@/lib/rate-limit'
import { captureError } from '@/lib/ops/errors'
import { requestIdOf } from '@/lib/ops/request-log'

// Claim a preview for the signed-in account (#416). The token comes from the request body (password path: this tab's
// sessionStorage) or the dazl_claim intent cookie (Google path), never from a URL. The write is atomic in
// claimPreview; failure codes never say more than the public page already would.

function tokenFrom(req: NextRequest, body: unknown): string {
  const b = (body as { token?: unknown } | null)?.token
  if (typeof b === 'string' && b) return b
  return req.cookies.get(PREVIEW_CLAIM_COOKIE)?.value ?? ''
}

export async function POST(req: NextRequest) {
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 403 })
  const rl = await rateLimit(`preview-claim:${clientIp(req)}`, 20, 10 * 60 * 1000)
  if (rl.unavailable) return NextResponse.json({ error: 'Briefly unavailable. Try again in a moment.', code: 'limits_unavailable' }, { status: 503, headers: { 'Retry-After': String(UNAVAILABLE_RETRY_S) } })
  if (!rl.ok) return NextResponse.json({ error: 'Too many attempts. Try again later.', code: 'too_many' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterS) } })
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in', code: 'signed_out' }, { status: 401 })
  const body = await req.json().catch(() => null)
  const token = tokenFrom(req, body)
  if (!isClaimToken(token)) return NextResponse.json({ error: 'This preview link is not valid.', code: 'unknown' }, { status: 404 })
  try {
    const c = await claimPreview(await getDb(), getMasterKey(), token, { actorId: user.actorId, tenantId: user.tenantId })
    if (c.status === 'claimed' || c.status === 'already') {
      const res = NextResponse.json({ ok: true, id: c.id })
      clearClaimCookie(res) // the intent is spent
      return res
    }
    if (c.status === 'unverified') return NextResponse.json({ error: 'Verify your email address to claim this preview.', code: 'unverified' }, { status: 403 })
    if (c.status === 'claimed_other_workspace') return NextResponse.json({ error: 'This preview was already claimed in another of your workspaces. Switch workspace to see it.', code: 'claimed_other_workspace' }, { status: 409 })
    if (c.status === 'expired') return NextResponse.json({ error: 'This preview has expired.', code: 'expired' }, { status: 410 })
    if (c.status === 'foreign') return NextResponse.json({ error: 'This preview was made for a different account.', code: 'foreign' }, { status: 403 })
    return NextResponse.json({ error: 'This preview link is not valid.', code: 'unknown' }, { status: 404 })
  } catch (e) {
    captureError(e, { source: 'route', where: '/api/preview/claim', method: 'POST', requestId: requestIdOf(req) })
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 })
  }
}

// Read-only confirmation details for the claim page (what am I about to claim?). Never consumes, never binds.
export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in', code: 'signed_out' }, { status: 401 })
  const token = req.nextUrl.searchParams.get('t') || req.cookies.get(PREVIEW_CLAIM_COOKIE)?.value || ''
  if (!isClaimToken(token)) return NextResponse.json({ error: 'This preview link is not valid.', code: 'unknown' }, { status: 404 })
  const c = await readPublicClaim(await getDb(), getMasterKey(), token)
  if (c.status === 'ok') return NextResponse.json({ ok: true, business: c.business, expiresAt: c.snapshot.expiresAt })
  return NextResponse.json({ error: 'This preview is no longer available.', code: c.status }, { status: c.status === 'unknown' ? 404 : 410 })
}
