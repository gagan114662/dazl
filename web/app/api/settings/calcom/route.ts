import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { getSecret, rotateSecret, listBookings, setManualOutcome } from '@/lib/calcom'
import { requestIdOf } from '@/lib/ops/request-log'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { audit } from '@/lib/audit-route'
import { denied, stale } from '@/lib/workspace-access'
import { can } from '@/lib/workspaces'

// Manage the tenant's Cal.com webhook: generate/rotate the signing secret and list recent bookings with their outcome
// (matched ones show their lead, unmatched stay visible so the user can reconcile by hand). POST action 'outcome' is
// the audited manual reconciliation of one booking (held / no_show / cancelled, or null to clear): the only way a
// meeting counts as held (lib/calcom setManualOutcome). Same gate as rotating: a member who may configure.
export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = await getDb()
  const secret = await getSecret(db, user.tenantId)
  // The signing secret can sign forged booking webhooks: only a member who may configure the workspace (admin, owner)
  // sees it, to paste into Cal.com. Everyone else reads the status and the bookings.
  // can_configure is the same role rule the POST handler enforces (the configure action): the panel shows set-up, rotate and reconcile controls
  // only when it is true, never inferred from whether a secret exists.
  const reveal = can(user.role, 'configure')
  return NextResponse.json({
    configured: !!secret,
    can_configure: reveal,
    // the server's clock (epoch seconds): the panel offers held / no-show by the rule setManualOutcome applies, with this now
    now: Math.floor(Date.now() / 1000),
    secret: reveal ? secret : null,
    secret_hidden: !!secret && !reveal,
    webhook_url: `${(process.env.PUBLIC_BASE_URL || req.nextUrl.origin).replace(/\/$/, '')}/api/hooks/calcom?u=${encodeURIComponent(user.tenantId)}`,
    bookings: await listBookings(db, user.tenantId),
  })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'configure'); if (no) return no
  const old = stale(user); if (old) return old

  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!(await rateLimit(`calcom-cfg:${user.tenantId}`, 10, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const body = await req.json().catch(() => null)
  if (body?.action === 'outcome') {
    const uid = typeof body.uid === 'string' && body.uid.length <= 120 ? body.uid : ''
    const outcome = body.outcome
    if (!uid || !(outcome === null || outcome === 'held' || outcome === 'no_show' || outcome === 'cancelled')) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
    const r = await setManualOutcome(await getDb(), user.tenantId, user.actorId, uid, outcome, { correlationId: requestIdOf(req) ?? null })
    if (!r.ok) {
      if (r.error === 'not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 })
      return NextResponse.json({ error: r.error === 'superseded' ? 'This booking was rescheduled: update the new booking instead.' : 'The meeting has not happened yet.', code: r.error }, { status: 409 })
    }
    return NextResponse.json({ ok: true, status: r.status })
  }
  if (body?.action !== 'rotate') return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const secret = await rotateSecret(await getDb(), user.tenantId)
  // the new secret goes back to the caller once; the trail records only that it changed
  await audit(user, req, { action: 'credential.rotated', resource: 'calcom' })
  return NextResponse.json({ ok: true, secret })
}
