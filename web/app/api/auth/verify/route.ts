import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { tokenOwner, verifyEmail } from '@/lib/email-ownership'
import { getScanDb } from '@/lib/scan/service'
import { activateLifecycleFor, recordLifecycleEvent } from '@/lib/outreach/lifecycle'
import { captureError } from '@/lib/ops/errors'
import { requestIdOf } from '@/lib/ops/request-log'

// Opens a verification link (the token from /verify#t=...). Public: the link may be opened in another browser. An
// unknown, used or expired link answers the same 410.
export async function POST(req: NextRequest) {
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!(await rateLimit(`verify:${clientIp(req)}`, 20, 60 * 60 * 1000)).ok) return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429 })
  const body = await req.json().catch(() => null)
  const owner = await tokenOwner(await getDb(), body?.token)
  const ok = await verifyEmail(await getDb(), body?.token)
  if (ok && owner) {
    // #417: verification is the ownership boundary. The account's conversion activates now (a queued pending
    // signup completes; an already-verified account that changed address records an activation), and any other
    // pending conversion for the address (a payment made while unverified) drains with it. Best-effort: the
    // pending rows are durable, so a lost drain completes at a later sign-in; never fails the verification.
    try {
      recordLifecycleEvent(getScanDb(), owner.purpose === 'change' ? 'activation' : 'signup', owner.email, owner.user_id)
      activateLifecycleFor(getScanDb(), owner.email)
    } catch (e) { captureError(e, { source: 'route', where: '/api/auth/verify:lifecycle', method: 'POST', requestId: requestIdOf(req) }) }
  }
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'invalid_link' }, { status: 410 })
}
