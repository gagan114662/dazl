import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { changeRole, listMembers, removeMember } from '@/lib/workspace-members'
import { isRole } from '@/lib/workspaces'
import { denied, isId, memberFail, stale } from '@/lib/workspace-access'
import { audit } from '@/lib/audit-route'

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
  const old = stale(user); if (old) return old
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  if (!isId(body?.member_id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (!isRole(body?.role)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  try {
    const from = await changeRole(await getDb(), user, body.member_id, body.role)
    // the roles only; a role set to the one the member already holds changed nothing and records nothing
    if (from !== body.role) await audit(user, req, { action: 'member.role_changed', resource: 'member', id: body.member_id, summary: { from, to: body.role } })
    return NextResponse.json({ ok: true })
  } catch (e) { return memberFail(e) }
}

// Remove another member; their devices acting in this workspace are signed out (offboarding, docs/design/sessions.md).
// Leaving yourself is POST /api/workspace/leave.
export async function DELETE(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'members'); if (no) return no
  const old = stale(user); if (old) return old
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  if (!isId(body?.member_id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  try {
    const role = await removeMember(await getDb(), user, body.member_id)
    await audit(user, req, { action: 'member.removed', resource: 'member', id: body.member_id, summary: { role } })
    return NextResponse.json({ ok: true })
  } catch (e) { return memberFail(e) }
}
