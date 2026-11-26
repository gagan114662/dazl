import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { READ_CONSENT_TEXT, READ_CONSENT_VERSION, syncReplies } from '@/lib/outreach/replies'
import { BOUNCE_SCAN_CONSENT_TEXT, BOUNCE_SCAN_CONSENT_VERSION } from '@/lib/outreach/bounce-scan'
import { followupsEnabled, runFollowups } from '@/lib/outreach/followups'
import { autopilotAvailable, CONSENT_VERSION } from '@/lib/outreach/autopilot'
import { AUTOPILOT_BETA_TEXT } from '@/lib/beta'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { denied } from '@/lib/workspace-access'
import { getDb } from '@/lib/db/client'
import { readGmailStatus } from '@/lib/gmail/oauth'
import { disableReplyFollowups, enableReplyFollowups, recordReplyConsent, removeReplyConsent } from '@/lib/outreach/reply-consent-db'
import { audit } from '@/lib/audit-route'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = await getDb()
  const tenant = user.tenantId
  const [gmail, consent, bounceConsent, settings, inbound] = await Promise.all([
    readGmailStatus(db, tenant),
    db.get<{ version: string }>('SELECT version FROM mail_read_consent WHERE tenant_id = ?', [tenant]),
    db.get<{ version: string }>('SELECT version FROM mail_bounce_scan_consent WHERE tenant_id = ?', [tenant]),
    db.get<{ enabled: number; followups_enabled: number }>('SELECT enabled, followups_enabled FROM autopilot_settings WHERE tenant_id = ?', [tenant]),
    db.all<{ from_email: string; excerpt: string; classification: string; received_at: number }>(
      'SELECT from_email, excerpt, classification, received_at FROM inbound_messages WHERE tenant_id = ? ORDER BY received_at DESC LIMIT 30', [tenant]),
  ])
  const gmail_status = !gmail ? 'none' : gmail.status === 'active' ? 'active' : 'needs_reconnect'
  const autopilot_available = autopilotAvailable()
  return NextResponse.json({
    available: true,
    gmail_connected: gmail_status === 'active',
    gmail_status,
    consent: { version: READ_CONSENT_VERSION, text: READ_CONSENT_TEXT, accepted: consent?.version === READ_CONSENT_VERSION },
    bounce_scan: { version: BOUNCE_SCAN_CONSENT_VERSION, text: BOUNCE_SCAN_CONSENT_TEXT, accepted: bounceConsent?.version === BOUNCE_SCAN_CONSENT_VERSION },
    read_granted: gmail?.read_granted ?? false,
    followups_enabled: Number(settings?.followups_enabled) === 1,
    autopilot_available,
    autopilot_on: autopilot_available && Number(settings?.enabled) === 1,
    inbound: inbound.map(row => ({ ...row, received_at: Number(row.received_at) })),
  })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'send'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  switch (body?.action) {
    case 'consent': {
      if (body.accept !== true || body.version !== READ_CONSENT_VERSION) return NextResponse.json({ error: 'Consent not recorded' }, { status: 400 })
      if (await recordReplyConsent(await getDb(), 'mail_read_consent', user.tenantId, READ_CONSENT_VERSION)) await audit(user, req, { action: 'consent.accepted', resource: 'reply_reading', summary: { version: READ_CONSENT_VERSION } })
      return NextResponse.json({ ok: true })
    }
    case 'revoke': {
      // revoking consent that is not on record (any version) changes nothing, so it records nothing; follow-ups being on
      // without consent cannot happen (followups_on requires it)
      if (await removeReplyConsent(await getDb(), 'mail_read_consent', user.tenantId)) await audit(user, req, { action: 'consent.revoked', resource: 'reply_reading' })
      return NextResponse.json({ ok: true })
    }
    case 'bounce_scan_on': {
      if (body.accept !== true || body.version !== BOUNCE_SCAN_CONSENT_VERSION) return NextResponse.json({ error: 'Consent not recorded' }, { status: 400 })
      if (await recordReplyConsent(await getDb(), 'mail_bounce_scan_consent', user.tenantId, BOUNCE_SCAN_CONSENT_VERSION)) await audit(user, req, { action: 'consent.accepted', resource: 'bounce_scan', summary: { version: BOUNCE_SCAN_CONSENT_VERSION } })
      return NextResponse.json({ ok: true })
    }
    case 'bounce_scan_off': {
      if (await removeReplyConsent(await getDb(), 'mail_bounce_scan_consent', user.tenantId)) await audit(user, req, { action: 'consent.revoked', resource: 'bounce_scan' })
      return NextResponse.json({ ok: true })
    }
    case 'followups_off': {
      if (await disableReplyFollowups(await getDb(), user.tenantId)) await audit(user, req, { action: 'followups.disabled', resource: 'followups' })
      return NextResponse.json({ ok: true })
    }
    case 'followups_on': {
      const result = await enableReplyFollowups(await getDb(), user.tenantId, {
        replyVersion: READ_CONSENT_VERSION,
        autopilotVersion: CONSENT_VERSION,
        autopilotAvailable: autopilotAvailable(),
      })
      if (result === 'read_required') return NextResponse.json({ error: 'Turn on reply reading first' }, { status: 400 })
      if (result === 'unavailable') return NextResponse.json({ error: AUTOPILOT_BETA_TEXT, code: 'autopilot_unavailable' }, { status: 400 })
      if (result === 'autopilot_required') return NextResponse.json({ error: 'Turn on autopilot first' }, { status: 400 })
      if (result === 'enabled') await audit(user, req, { action: 'followups.enabled', resource: 'followups' })
      return NextResponse.json({ ok: true })
    }
    case 'sync': {
      if (!(await rateLimit(`sync:${user.tenantId}`, 6, 60 * 60 * 1000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
      const db = getScanDb()
      const r = await syncReplies(db, user.tenantId)
      const f = !r.error && followupsEnabled(db, user.tenantId) ? await runFollowups(db, user.tenantId, user.business_name) : null
      return NextResponse.json({ ok: true, sync: r, followups: f })
    }
  }
  return NextResponse.json({ error: 'Bad request' }, { status: 400 })
}
