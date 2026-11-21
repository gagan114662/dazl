import { systemMailAvailable } from '@/lib/system-mail'
import { after, NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { validateEmail } from '@/lib/validate'
import { requestReset } from '@/lib/email-ownership'
import { captureError } from '@/lib/ops/errors'
import { requestIdOf } from '@/lib/ops/request-log'

const OK = () => NextResponse.json({ ok: true, message: 'If an account uses that email, we sent it a link.' })
const TOO_MANY = (retryAfterS: number) => NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429, headers: { 'Retry-After': String(retryAfterS) } })

// "Forgot password". The answer is the same whether or not an account uses the email, and whether or not sending
// worked, so it reveals nothing about which emails have accounts (#841): the same status and body, and the same work
// before it, because looking the account up and mailing it happen after the response (after()), so a known address
// does not answer slower than an unknown one. Rate limited per IP and per email; either limit answers the same 429.
export async function POST(req: NextRequest) {
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!systemMailAvailable()) return NextResponse.json({ error: 'Email delivery is not available. Try again later.' }, { status: 503 })
  const body = await req.json().catch(() => null)
  const email = validateEmail(body?.email)
  const ip = await rateLimit(`reset-ip:${clientIp(req)}`, 10, 60 * 60 * 1000)
  if (!ip.ok) return TOO_MANY(ip.retryAfterS)
  if (!email) return OK()
  // keyed by the address whether or not an account uses it, so the limit itself says nothing about accounts
  const acct = await rateLimit(`reset-email:${createHash('sha256').update(email).digest('hex').slice(0, 32)}`, 3, 60 * 60 * 1000)
  if (!acct.ok) return TOO_MANY(acct.retryAfterS)
  const requestId = requestIdOf(req)
  after(async () => {
    try { await requestReset(await getDb(), email) } catch (e) { captureError(e, { source: 'route', where: '/api/auth/reset/request', method: 'POST', requestId }) }
  })
  return OK()
}
