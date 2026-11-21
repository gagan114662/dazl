import { systemMailAvailable } from '@/lib/system-mail'
import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { sendVerification } from '@/lib/email-ownership'

// Send (again) a verification link to the signed-in account's own email. Earlier links stop working. Rate limited per
// IP, per account and per email (#841); every limit answers the same generic 429.
export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
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
