import { NextRequest, NextResponse } from 'next/server'
import { randomBytes, scryptSync } from 'crypto'
import { cookies } from 'next/headers'
import { createSession, getAuthDb, SESSION_TTL_S } from '@/lib/auth-db'
import { cleanText, validateEmail, validatePassword } from '@/lib/validate'
import { clientIp, rateLimit } from '@/lib/rate-limit'

export async function POST(req: NextRequest) {
  const rl = rateLimit(`signup:${clientIp(req)}`, 5, 60 * 60 * 1000)
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

    try {
      getAuthDb()
        .prepare('INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, email, cleanText(body.name, 100), cleanText(body.business_name, 150), hash, salt)
    } catch (e) {
      if (e instanceof Error && e.message.includes('UNIQUE')) {
        // Same response shape as other failures: do not reveal which emails exist.
        return NextResponse.json({ error: 'We could not create an account with those details. Try signing in instead.' }, { status: 400 })
      }
      throw e
    }

    const token = createSession(id)
    const cookieStore = await cookies()
    cookieStore.set('dazl_session', token, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: SESSION_TTL_S, path: '/' })
    return NextResponse.json({ ok: true, redirect: '/app' })
  } catch (e) {
    console.error('signup failed', e)
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 })
  }
}
