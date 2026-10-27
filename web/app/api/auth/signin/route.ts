import { NextRequest, NextResponse } from 'next/server'
import { scryptSync, timingSafeEqual } from 'crypto'
import { cookies } from 'next/headers'
import { createSession, findPasswordUser, SESSION_TTL_S } from '@/lib/auth-db'
import { validateEmail } from '@/lib/validate'
import { clientIp, rateLimit } from '@/lib/rate-limit'

// Fixed dummy salt/hash so unknown emails cost the same time as known ones.
const DUMMY_SALT = '00000000000000000000000000000000'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null)
    const email = validateEmail(body?.email)
    const password = typeof body?.password === 'string' ? body.password : ''
    const ip = rateLimit(`signin-ip:${clientIp(req)}`, 20, 15 * 60 * 1000)
    const acct = rateLimit(`signin-acct:${email ?? 'invalid'}`, 8, 15 * 60 * 1000)
    if (!ip.ok || !acct.ok) {
      const retry = Math.max(ip.retryAfterS, acct.retryAfterS)
      return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429, headers: { 'Retry-After': String(retry) } })
    }
    const fail = () => NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
    if (!email || !password || password.length > 200) return fail()

    const user = await findPasswordUser(email)
    const computed = scryptSync(password, user?.salt ?? DUMMY_SALT, 64)
    const stored = Buffer.from(user?.password_hash ?? '0'.repeat(128), 'hex')
    if (!user || !timingSafeEqual(computed, stored)) return fail()

    const token = await createSession(user.id)
    const cookieStore = await cookies()
    cookieStore.set('dazl_session', token, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: SESSION_TTL_S, path: '/' })
    return NextResponse.json({ ok: true, redirect: '/app' })
  } catch (e) {
    console.error('signin failed', e)
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 })
  }
}
