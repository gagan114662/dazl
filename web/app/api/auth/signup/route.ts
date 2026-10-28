import { NextRequest, NextResponse } from 'next/server'
import { randomBytes, scryptSync } from 'crypto'
import { cookies } from 'next/headers'
import { createPasswordUser, createSession, SESSION_TTL_S } from '@/lib/auth-db'
import { cleanText, validateEmail, validatePassword } from '@/lib/validate'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { captureError } from '@/lib/ops/errors'
import { requestIdOf } from '@/lib/ops/request-log'

export async function POST(req: NextRequest) {
  const rl = (await rateLimit(`signup:${clientIp(req)}`, 5, 60 * 60 * 1000))
  if (!rl.ok) {
    return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterS) } })
  }
  try {
    const body = await req.json().catch(() => null)
    const email = validateEmail(body?.email)
    if (!email) return NextResponse.json({ error: 'Enter a valid email address' }, { status: 400 })
    const pwError = validatePassword(body?.password)
    if (pwError) return NextResponse.json({ error: pwError }, { status: 400 })

    const salt = randomBytes(16).toString('hex')
    const hash = scryptSync(body.password, salt, 64).toString('hex')
    const id = randomBytes(16).toString('hex')

    const made = await createPasswordUser({ id, email, name: cleanText(body.name, 100), business_name: cleanText(body.business_name, 150), password_hash: hash, salt })
    if (made === 'exists') {
      // Same response shape as other failures: do not reveal which emails exist.
      return NextResponse.json({ error: 'We could not create an account with those details. Try signing in instead.' }, { status: 400 })
    }

    const token = await createSession(id)
    const cookieStore = await cookies()
    cookieStore.set('dazl_session', token, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: SESSION_TTL_S, path: '/' })
    return NextResponse.json({ ok: true, redirect: '/app' })
  } catch (e) {
    captureError(e, { source: 'route', where: '/api/auth/signup', method: 'POST', requestId: requestIdOf(req) })
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 })
  }
}
