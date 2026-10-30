import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { acceptReadConsent, bounceCoverage, hasReadConsent, READ_CONSENT_TEXT, READ_CONSENT_VERSION, recentInbound, revokeReadConsent, syncReplies } from '@/lib/outreach/replies'
import { followupsEnabled, runFollowups, setFollowups } from '@/lib/outreach/followups'
import { getState } from '@/lib/outreach/autopilot'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  const acc = db.prepare('SELECT read_granted, status FROM gmail_accounts WHERE tenant_id = ?').get(user.id) as { read_granted: number; status: string } | undefined
  return NextResponse.json({ available: true, gmail_connected: !!acc, consent: { version: READ_CONSENT_VERSION, text: READ_CONSENT_TEXT, accepted: hasReadConsent(db, user.id) }, read_granted: acc?.read_granted === 1, bounce_coverage: bounceCoverage(db, user.id), followups_enabled: followupsEnabled(db, user.id), autopilot_on: getState(db, user.id).enabled, inbound: recentInbound(db, user.id) })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  const db = getScanDb()
  switch (body?.action) {
    case 'consent':
      if (body.accept !== true || body.version !== READ_CONSENT_VERSION) return NextResponse.json({ error: 'Consent not recorded' }, { status: 400 })
      acceptReadConsent(db, user.id); return NextResponse.json({ ok: true })
    case 'revoke': revokeReadConsent(db, user.id); return NextResponse.json({ ok: true })
    case 'followups_off': setFollowups(db, user.id, false); return NextResponse.json({ ok: true })
    case 'followups_on': {
      const acc = db.prepare('SELECT read_granted FROM gmail_accounts WHERE tenant_id = ?').get(user.id) as { read_granted: number } | undefined
      if (!hasReadConsent(db, user.id) || acc?.read_granted !== 1) return NextResponse.json({ error: 'Turn on reply reading first' }, { status: 400 })
      if (!getState(db, user.id).enabled || !getState(db, user.id).consent_current) return NextResponse.json({ error: 'Turn on autopilot first' }, { status: 400 })
      setFollowups(db, user.id, true); return NextResponse.json({ ok: true })
    }
    case 'sync': {
      if (!(await rateLimit(`sync:${user.id}`, 6, 60 * 60 * 1000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
      const r = await syncReplies(db, user.id)
      const f = !r.error && followupsEnabled(db, user.id) ? await runFollowups(db, user.id, user.business_name) : null
      return NextResponse.json({ ok: true, sync: r, followups: f })
    }
  }
  return NextResponse.json({ error: 'Bad request' }, { status: 400 })
}
