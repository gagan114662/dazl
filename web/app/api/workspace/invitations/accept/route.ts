import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { hashToken } from '@/lib/auth-db'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { acceptInvitation, switchWorkspace } from '@/lib/workspace-members'
import { memberFail } from '@/lib/workspace-access'

// Accept an invitation as the signed-in account, then act in that workspace. The account's email must be the one
// invited; an unknown, used, revoked or expired link answers the same 410.
export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!(await rateLimit(`invite-accept:${user.actorId}`, 10, 60 * 60 * 1000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const body = await req.json().catch(() => null)
  try {
    const db = await getDb()
    const m = await acceptInvitation(db, user, body?.token)
    const token = (await cookies()).get('dazl_session')?.value
    // the invitation is already used up and the membership added: a failed switch (the session ended meanwhile) must not
    // report the accept as failed, so the next sign-in simply offers the workspace
    if (token) await switchWorkspace(db, hashToken(token), user.actorId, m.tenantId).catch(() => {})
    return NextResponse.json({ ok: true, tenant_id: m.tenantId, role: m.role })
  } catch (e) { return memberFail(e) }
}
