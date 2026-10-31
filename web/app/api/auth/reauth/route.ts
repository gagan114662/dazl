import { NextRequest, NextResponse } from 'next/server'
import { scryptSync, timingSafeEqual } from 'crypto'
import { cookies } from 'next/headers'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { markSessionFresh } from '@/lib/auth-db'
import { sameOriginJson } from '@/lib/same-origin'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { FRESH_AUTH_S } from '@/lib/sessions'

// Whether this session may change secrets, billing and members right now, until when, and how it re-authenticates:
// 'password', or 'google' (sign in with Google again: /api/auth/google?reauth=1).
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const google = await (await getDb()).get("SELECT 1 AS x FROM oauth_identities WHERE provider = 'google' AND user_id = ?", [user.actorId])
  const until = user.authedAt + FRESH_AUTH_S
  return NextResponse.json({ fresh: Math.floor(Date.now() / 1000) <= until, fresh_until: until, method: google ? 'google' : 'password' })
}

// Re-enter the account password: this session is fresh for another hour. A wrong password changes nothing.
export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const a = await rateLimit(`reauth:${user.actorId}`, 8, 15 * 60 * 1000), ip = await rateLimit(`reauth-ip:${clientIp(req)}`, 20, 15 * 60 * 1000)
  if (!a.ok || !ip.ok) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429, headers: { 'Retry-After': String(Math.max(a.retryAfterS, ip.retryAfterS)) } })
  const body = await req.json().catch(() => null)
  const password = typeof body?.password === 'string' ? body.password : ''
  const row = await (await getDb()).get<{ password_hash: string; salt: string }>('SELECT password_hash, salt FROM users WHERE id = ?', [user.actorId])
  const fail = () => NextResponse.json({ error: 'That password is not right' }, { status: 401 })
  if (!row || !password || password.length > 200) return fail()
  const computed = scryptSync(password, row.salt, 64), stored = Buffer.from(row.password_hash, 'hex')
  if (stored.length !== computed.length || !timingSafeEqual(computed, stored)) return fail()
  const token = (await cookies()).get('dazl_session')?.value
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  await markSessionFresh(token)
  return NextResponse.json({ ok: true, fresh_until: Math.floor(Date.now() / 1000) + FRESH_AUTH_S })
}
