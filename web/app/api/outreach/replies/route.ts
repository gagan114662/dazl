import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { acceptReadConsent, hasReadConsent, READ_CONSENT_TEXT, READ_CONSENT_VERSION, recentInbound, revokeReadConsent, syncReplies } from '@/lib/outreach/replies'
import { followupsEnabled, runFollowups, setFollowups } from '@/lib/outreach/followups'
import { getState } from '@/lib/outreach/autopilot'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { audited, denied } from '@/lib/workspace-access'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  const acc = db.prepare('SELECT read_granted, status FROM gmail_accounts WHERE tenant_id = ?').get(user.tenantId) as { read_granted: number; status: string } | undefined
  return NextResponse.json({ available: true, gmail_connected: !!acc, consent: { version: READ_CONSENT_VERSION, text: READ_CONSENT_TEXT, accepted: hasReadConsent(db, user.tenantId) }, read_granted: acc?.read_granted === 1, followups_enabled: followupsEnabled(db, user.tenantId), autopilot_on: getState(db, user.tenantId).enabled, inbound: recentInbound(db, user.tenantId) })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = await denied(user, 'send'); if (no) return no
  const done = audited(user, 'outreach.replies_action', 'outreach')
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  const db = getScanDb()
  switch (body?.action) {
    case 'consent':
      if (body.accept !== true || body.version !== READ_CONSENT_VERSION) return NextResponse.json({ error: 'Consent not recorded' }, { status: 400 })
      acceptReadConsent(db, user.tenantId); return done({ ok: true }, undefined, { action: body?.action })
    case 'revoke': revokeReadConsent(db, user.tenantId); return done({ ok: true }, undefined, { action: body?.action })
    case 'followups_off': setFollowups(db, user.tenantId, false); return done({ ok: true }, undefined, { action: body?.action })
    case 'followups_on': {
      const acc = db.prepare('SELECT read_granted FROM gmail_accounts WHERE tenant_id = ?').get(user.tenantId) as { read_granted: number } | undefined
      if (!hasReadConsent(db, user.tenantId) || acc?.read_granted !== 1) return NextResponse.json({ error: 'Turn on reply reading first' }, { status: 400 })
      if (!getState(db, user.tenantId).enabled || !getState(db, user.tenantId).consent_current) return NextResponse.json({ error: 'Turn on autopilot first' }, { status: 400 })
      setFollowups(db, user.tenantId, true); return done({ ok: true }, undefined, { action: body?.action })
    }
    case 'sync': {
      if (!(await rateLimit(`sync:${user.tenantId}`, 6, 60 * 60 * 1000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
      const r = await syncReplies(db, user.tenantId)
      const f = !r.error && followupsEnabled(db, user.tenantId) ? await runFollowups(db, user.tenantId, user.business_name) : null
      return done({ ok: true, sync: r, followups: f }, undefined, { action: body?.action })
    }
  }
  return NextResponse.json({ error: 'Bad request' }, { status: 400 })
}
