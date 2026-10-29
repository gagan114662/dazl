import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { hashToken } from '@/lib/auth-db'
import { sameOriginJson } from '@/lib/same-origin'
import { switchWorkspace } from '@/lib/workspace-members'
import { isId, memberFail } from '@/lib/workspace-access'

// Act in another workspace this account is a member of. The membership is checked here and again on every request.
export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  if (!isId(body?.tenant_id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const token = (await cookies()).get('dazl_session')?.value
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  try {
    await switchWorkspace(await getDb(), hashToken(token), user.actorId, body.tenant_id)
    return NextResponse.json({ ok: true, tenant_id: body.tenant_id })
  } catch (e) { return memberFail(e) }
}
