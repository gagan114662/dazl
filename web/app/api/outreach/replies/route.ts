import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { acceptReadConsent, hasReadConsent, READ_CONSENT_TEXT, READ_CONSENT_VERSION, recentInbound, revokeReadConsent, syncReplies } from '@/lib/outreach/replies'
import { acceptBounceScanConsent, BOUNCE_SCAN_CONSENT_TEXT, BOUNCE_SCAN_CONSENT_VERSION, hasBounceScanConsent, revokeBounceScanConsent } from '@/lib/outreach/bounce-scan'
import { followupsEnabled, runFollowups, setFollowups } from '@/lib/outreach/followups'
import { getState } from '@/lib/outreach/autopilot'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { denied } from '@/lib/workspace-access'
import { audit } from '@/lib/audit-route'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  const acc = db.prepare('SELECT read_granted, status FROM gmail_accounts WHERE tenant_id = ?').get(user.tenantId) as { read_granted: number; status: string } | undefined
  const gmail_status = !acc ? 'none' : acc.status === 'active' ? 'active' : 'needs_reconnect'
  // #931: connected means an ACTIVE account; a needs_reconnect row is reported separately, not as connected
  return NextResponse.json({ available: true, gmail_connected: gmail_status === 'active', gmail_status, consent: { version: READ_CONSENT_VERSION, text: READ_CONSENT_TEXT, accepted: hasReadConsent(db, user.tenantId) }, bounce_scan: { version: BOUNCE_SCAN_CONSENT_VERSION, text: BOUNCE_SCAN_CONSENT_TEXT, accepted: hasBounceScanConsent(db, user.tenantId) }, read_granted: acc?.read_granted === 1, followups_enabled: followupsEnabled(db, user.tenantId), autopilot_on: getState(db, user.tenantId).enabled, inbound: recentInbound(db, user.tenantId) })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'send'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  const db = getScanDb()
  switch (body?.action) {
    case 'consent': {
      if (body.accept !== true || body.version !== READ_CONSENT_VERSION) return NextResponse.json({ error: 'Consent not recorded' }, { status: 400 })
      // accepting the version already on record changes nothing, so it records nothing
      const had = hasReadConsent(db, user.tenantId)
      acceptReadConsent(db, user.tenantId)
      if (!had) await audit(user, req, { action: 'consent.accepted', resource: 'reply_reading', summary: { version: READ_CONSENT_VERSION } })
      return NextResponse.json({ ok: true })
    }
    case 'revoke': {
      // revoking consent that is not on record (any version) changes nothing, so it records nothing; follow-ups being on
      // without consent cannot happen (followups_on requires it)
      if (revokeReadConsent(db, user.tenantId)) await audit(user, req, { action: 'consent.revoked', resource: 'reply_reading' })
      return NextResponse.json({ ok: true })
    }
    case 'bounce_scan_on': {
      if (body.accept !== true || body.version !== BOUNCE_SCAN_CONSENT_VERSION) return NextResponse.json({ error: 'Consent not recorded' }, { status: 400 })
      const hadBounce = hasBounceScanConsent(db, user.tenantId)
      acceptBounceScanConsent(db, user.tenantId)
      if (!hadBounce) await audit(user, req, { action: 'consent.accepted', resource: 'bounce_scan', summary: { version: BOUNCE_SCAN_CONSENT_VERSION } })
      return NextResponse.json({ ok: true })
    }
    case 'bounce_scan_off': {
      if (revokeBounceScanConsent(db, user.tenantId)) await audit(user, req, { action: 'consent.revoked', resource: 'bounce_scan' })
      return NextResponse.json({ ok: true })
    }
    case 'followups_off': {
      const was = followupsEnabled(db, user.tenantId)
      setFollowups(db, user.tenantId, false)
      if (was) await audit(user, req, { action: 'followups.disabled', resource: 'followups' })
      return NextResponse.json({ ok: true })
    }
    case 'followups_on': {
      const acc = db.prepare('SELECT read_granted FROM gmail_accounts WHERE tenant_id = ?').get(user.tenantId) as { read_granted: number } | undefined
      if (!hasReadConsent(db, user.tenantId) || acc?.read_granted !== 1) return NextResponse.json({ error: 'Turn on reply reading first' }, { status: 400 })
      if (!getState(db, user.tenantId).enabled || !getState(db, user.tenantId).consent_current) return NextResponse.json({ error: 'Turn on autopilot first' }, { status: 400 })
      const was = followupsEnabled(db, user.tenantId)
      setFollowups(db, user.tenantId, true)
      if (!was) await audit(user, req, { action: 'followups.enabled', resource: 'followups' })
      return NextResponse.json({ ok: true })
    }
    case 'sync': {
      if (!(await rateLimit(`sync:${user.tenantId}`, 6, 60 * 60 * 1000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
      const r = await syncReplies(db, user.tenantId)
      const f = !r.error && followupsEnabled(db, user.tenantId) ? await runFollowups(db, user.tenantId, user.business_name) : null
      return NextResponse.json({ ok: true, sync: r, followups: f })
    }
  }
  return NextResponse.json({ error: 'Bad request' }, { status: 400 })
}
