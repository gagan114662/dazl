// Settings > LinkedIn extension (#1122): create the extension token (shown once, stored hashed; a new one replaces the old one),
// revoke it, pause or resume reading, and the status (never the token).
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { denied, stale } from '@/lib/workspace-access'
import { createExtensionToken, extensionStatus, revokeExtensionToken, setPaused } from '@/lib/linkedin-tasks/store'
import { validZone } from '@/lib/linkedin-tasks/limits'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  return NextResponse.json(await extensionStatus(await getDb(), user.tenantId))
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'configure'); if (no) return no
  const old = stale(user); if (old) return old
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null) as { action?: unknown; timezone?: unknown } | null
  const db = await getDb()
  if (body?.action === 'create') {
    const tz = validZone(body.timezone)
    if (!tz) return NextResponse.json({ error: 'Your browser did not report a time zone' }, { status: 400 })
    return NextResponse.json({ token: await createExtensionToken(db, user.tenantId, user.actorId, tz) }, { headers: { 'cache-control': 'no-store' } })
  }
  if (body?.action === 'revoke') return NextResponse.json({ ok: await revokeExtensionToken(db, user.tenantId) })
  if (body?.action === 'pause' || body?.action === 'resume') { await setPaused(db, user.tenantId, body.action === 'pause'); return NextResponse.json({ ok: true }) }
  return NextResponse.json({ error: 'Bad request' }, { status: 400 })
}
