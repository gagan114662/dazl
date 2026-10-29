import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { hashToken } from '@/lib/auth-db'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { listSessions, revokeSession } from '@/lib/sessions'
import { requestIdOf } from '@/lib/ops/request-log'

const currentHash = async () => { const t = (await cookies()).get('dazl_session')?.value; return t ? hashToken(t) : null }

// The signed-in account's own working sessions: device, when it signed in, last activity, which one is this one.
// Never a token or its hash: each row is named by a random public id.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  return NextResponse.json({ sessions: await listSessions(await getDb(), user.actorId, await currentHash()) })
}

// Sign one of the account's own sessions out. It fails on its next request, on every instance.
export async function DELETE(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!(await rateLimit(`sessions:${user.actorId}`, 30, 60 * 60 * 1000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const body = await req.json().catch(() => null)
  const ok = await revokeSession(await getDb(), user.actorId, body?.id, user.actorId, 'revoked', undefined, requestIdOf(req))
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'not_found' }, { status: 404 })
}
