import { NextRequest, NextResponse } from 'next/server'
import { randomBytes, scryptSync } from 'crypto'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { validatePassword } from '@/lib/validate'
import { isEmailToken, resetPassword } from '@/lib/email-ownership'

// Opens a reset link with a new password. Success signs the account out everywhere; the person then signs in with
// the new password. An unknown, used or expired link answers the same 410.
export async function POST(req: NextRequest) {
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!(await rateLimit(`reset:${clientIp(req)}`, 10, 60 * 60 * 1000)).ok) return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429 })
  const body = await req.json().catch(() => null)
  if (!isEmailToken(body?.token)) return NextResponse.json({ error: 'invalid_link' }, { status: 410 })
  const pwError = validatePassword(body?.password)
  if (pwError) return NextResponse.json({ error: pwError }, { status: 400 })
  const salt = randomBytes(16).toString('hex')
  const ok = await resetPassword(await getDb(), body.token, { password_hash: scryptSync(body.password, salt, 64).toString('hex'), salt })
  return ok ? NextResponse.json({ ok: true, redirect: '/sign-in?reset=1' }) : NextResponse.json({ error: 'invalid_link' }, { status: 410 })
}
