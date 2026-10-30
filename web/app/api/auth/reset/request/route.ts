import { systemMailAvailable } from '@/lib/system-mail'
import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { validateEmail } from '@/lib/validate'
import { requestReset } from '@/lib/email-ownership'
import { captureError } from '@/lib/ops/errors'
import { requestIdOf } from '@/lib/ops/request-log'

const OK = () => NextResponse.json({ ok: true, message: 'If an account uses that email, we sent it a link.' })

// "Forgot password". The answer is the same whether or not an account uses the email, and whether or not sending
// worked, so it reveals nothing about which emails have accounts.
export async function POST(req: NextRequest) {
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!systemMailAvailable()) return NextResponse.json({ error: 'Email delivery is not available. Try again later.' }, { status: 503 })
  const body = await req.json().catch(() => null)
  const email = validateEmail(body?.email)
  const ip = await rateLimit(`reset-ip:${clientIp(req)}`, 10, 60 * 60 * 1000)
  const acct = await rateLimit(`reset-email:${createHash('sha256').update(email ?? 'invalid').digest('hex').slice(0, 32)}`, 3, 60 * 60 * 1000)
  if (!ip.ok) return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429, headers: { 'Retry-After': String(ip.retryAfterS) } })
  if (!email || !acct.ok) return OK()
  try { await requestReset(await getDb(), email) } catch (e) { captureError(e, { source: 'route', where: '/api/auth/reset/request', method: 'POST', requestId: requestIdOf(req) }) }
  return OK()
}
