import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { changeRole, listMembers, removeMember } from '@/lib/workspace-members'
import { isRole } from '@/lib/workspaces'
import { denied, isId, memberFail } from '@/lib/workspace-access'

// Who is in this workspace and as what. Every member may see the team.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  return NextResponse.json({ members: await listMembers(await getDb(), user.tenantId), you: user.actorId })
}

// Change a member's role. Owners alone grant or remove the owner role; the last owner cannot be demoted.
export async function PATCH(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'members'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  if (!isId(body?.member_id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (!isRole(body?.role)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  try {
    await changeRole(await getDb(), user, body.member_id, body.role)
    return NextResponse.json({ ok: true })
  } catch (e) { return memberFail(e) }
}

// Remove another member; access ends on their next request. Leaving yourself is POST /api/workspace/leave.
export async function DELETE(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'members'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  if (!isId(body?.member_id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  try {
    await removeMember(await getDb(), user, body.member_id)
    return NextResponse.json({ ok: true })
  } catch (e) { return memberFail(e) }
}
