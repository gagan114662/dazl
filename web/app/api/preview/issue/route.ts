import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { getMasterKey } from '@/lib/secrets'
import { issuePreviewClaim } from '@/lib/scan/preview-claim'
import { sameOriginJson } from '@/lib/same-origin'
import { cleanText, validateEmail } from '@/lib/validate'
import { clientIp, rateLimit, UNAVAILABLE_RETRY_S } from '@/lib/rate-limit'
import { captureError } from '@/lib/ops/errors'
import { requestIdOf } from '@/lib/ops/request-log'

// Issue a preview claim for one of the signed-in workspace's own finished runs (#416): this is where a selected
// proof enters the auth handoff. Another workspace's run id reads as not found; a run whose proof holds issues
// nothing. The returned link is the whole deliverable - sending it anywhere is a separate, governed act.
export async function POST(req: NextRequest) {
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 403 })
  const rl = await rateLimit(`preview-issue:${clientIp(req)}`, 20, 10 * 60 * 1000)
  if (rl.unavailable) return NextResponse.json({ error: 'Briefly unavailable. Try again in a moment.', code: 'limits_unavailable' }, { status: 503, headers: { 'Retry-After': String(UNAVAILABLE_RETRY_S) } })
  if (!rl.ok) return NextResponse.json({ error: 'Too many attempts. Try again later.', code: 'too_many' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterS) } })
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in', code: 'signed_out' }, { status: 401 })
  const body = await req.json().catch(() => null)
  const runId = typeof body?.runId === 'string' ? body.runId : ''
  const business = cleanText(body?.business, 150)
  const recipient = validateEmail(body?.recipientEmail)
  if (!/^[0-9a-f]{24}$/.test(runId) || !business || !recipient) return NextResponse.json({ error: 'A run, a business name and a valid recipient email are required.' }, { status: 400 })
  try {
    const r = await issuePreviewClaim(await getDb(), getMasterKey(), { runId, sellerTenantId: user.tenantId, recipientEmail: recipient, business })
    if (r === null) return NextResponse.json({ error: 'Run not found.', code: 'not_found' }, { status: 404 })
    if (r.status === 'hold') return NextResponse.json({ error: 'This run has no proof ready to show yet.', code: 'hold', reason: r.reason }, { status: 409 })
    const url = `${process.env.PUBLIC_BASE_URL || new URL(req.url).origin}/preview/${r.token}`
    return NextResponse.json({ ok: true, id: r.id, url, expiresAt: r.expiresAt })
  } catch (e) {
    captureError(e, { source: 'route', where: '/api/preview/issue', method: 'POST', requestId: requestIdOf(req) })
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 })
  }
}
