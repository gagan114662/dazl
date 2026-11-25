import { systemMailAvailable } from '@/lib/system-mail'
import { after, NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { sendVerification } from '@/lib/email-ownership'
import { validateEmail } from '@/lib/validate'
import { confirmationPending, findPasswordUser } from '@/lib/auth-db'
import { captureError } from '@/lib/ops/errors'
import { requestIdOf } from '@/lib/ops/request-log'

// Send (again) a verification link to the signed-in account's own email. Earlier links stop working. Rate limited per
// IP, per account and per email (#841); every limit answers the same generic 429.
// #1647: a user blocked by "Confirm your email first" is not signed in, so the same endpoint also takes an
// unauthenticated resend addressed by email. It answers the same for every well-formed address (unknown and confirmed
// included) and only an unconfirmed account's address gets a fresh link; the caps are per address (1/min, 5/hour) and
// per IP, every refusal the same generic 429.
export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) {
    if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
    if (!systemMailAvailable()) return NextResponse.json({ error: 'Email delivery is not available. Try again later.' }, { status: 503 })
    const body = await req.json().catch(() => null)
    const email = validateEmail(body?.email)
    if (!email) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
    const digest = createHash('sha256').update(email).digest('hex').slice(0, 32)
    const hour = 60 * 60 * 1000
    // checked in order (IP, address per minute, address per hour), each refusal returned before a later counter is spent
    for (const [key, limit, window] of [[`verify-resend-ip:${clientIp(req)}`, 10, hour], [`verify-resend-min:${digest}`, 1, 60 * 1000],
      [`verify-resend-hour:${digest}`, 5, hour]] as const) {
      const l = await rateLimit(key, limit, window)
      if (!l.ok) return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429, headers: { 'Retry-After': String(l.retryAfterS) } })
    }
    // the lookup and send happen after the response, like the reset request's: every well-formed address answers the
    // same 200 at the same speed, and a slow or failing mail can never turn the answer into an error or a tell (#1647)
    const requestId = requestIdOf(req)
    after(async () => {
      try {
        const account = await findPasswordUser(email)
        if (account && confirmationPending(account)) await sendVerification(await getDb(), account.id)
      } catch (e) { captureError(e, { source: 'route', where: '/api/auth/email/send-verification', method: 'POST', requestId }) }
    })
    return NextResponse.json({ ok: true })
  }
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!systemMailAvailable()) return NextResponse.json({ error: 'Email delivery is not available. Try again later.' }, { status: 503 })
  // checked in order (IP, account, email), each refusal returned before a later counter is spent
  const hour = 60 * 60 * 1000
  for (const [key, limit] of [[`verify-send-ip:${clientIp(req)}`, 10], [`verify-send:${user.actorId}`, 3],
    [`verify-send-email:${createHash('sha256').update(user.email.toLowerCase()).digest('hex').slice(0, 32)}`, 3]] as const) {
    const l = await rateLimit(key, limit, hour)
    if (!l.ok) return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429, headers: { 'Retry-After': String(l.retryAfterS) } })
  }
  return NextResponse.json({ ok: true, sent: await sendVerification(await getDb(), user.actorId) })
}
