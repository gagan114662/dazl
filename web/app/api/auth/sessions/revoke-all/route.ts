import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { hashToken } from '@/lib/auth-db'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { revokeAllSessions } from '@/lib/sessions'
import { requestIdOf } from '@/lib/ops/request-log'

// Sign the account out everywhere else ({ keep_current: true }, the default) or everywhere, this session included.
export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!(await rateLimit(`sessions:${user.actorId}`, 30, 60 * 60 * 1000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const body = await req.json().catch(() => null)
  const keepCurrent = body?.keep_current !== false
  const store = await cookies()
  const token = store.get('dazl_session')?.value
  const revoked = await revokeAllSessions(await getDb(), user.actorId, { by: user.actorId, reason: 'revoked_all', keepHash: keepCurrent && token ? hashToken(token) : null, correlationId: requestIdOf(req) })
  if (!keepCurrent) store.delete('dazl_session')
  return NextResponse.json({ ok: true, revoked })
}
