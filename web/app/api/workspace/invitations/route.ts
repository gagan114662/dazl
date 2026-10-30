import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { validateEmail } from '@/lib/validate'
import { createInvitation, listInvitations, revokeInvitation } from '@/lib/workspace-members'
import { isRole } from '@/lib/workspaces'
import { denied, isId, memberFail } from '@/lib/workspace-access'

// Pending invitations (email, role, expiry). Never a token.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'members'); if (no) return no
  return NextResponse.json({ invitations: await listInvitations(await getDb(), user.tenantId) })
}

// Invite someone by email. dazl sends no email yet: the response carries the one-time link, shown once to the
// inviter to pass on. The token sits in the link's #fragment, so it never reaches a server log.
export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'members'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!(await rateLimit(`invite:${user.tenantId}`, 30, 60 * 60 * 1000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const body = await req.json().catch(() => null)
  const email = validateEmail(body?.email)
  if (!email) return NextResponse.json({ error: 'Enter a valid email address' }, { status: 400 })
  if (!isRole(body?.role)) return NextResponse.json({ error: 'Pick a role' }, { status: 400 })
  try {
    const inv = await createInvitation(await getDb(), user, email, body.role)
    const base = process.env.PUBLIC_BASE_URL || req.nextUrl.origin
    return NextResponse.json({ id: inv.id, expires_at: inv.expires_at, link: `${base}/app/join#t=${inv.token}` })
  } catch (e) { return memberFail(e) }
}

export async function DELETE(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'members'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  if (!isId(body?.id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  try {
    await revokeInvitation(await getDb(), user, body.id)
    return NextResponse.json({ ok: true })
  } catch (e) { return memberFail(e) }
}
