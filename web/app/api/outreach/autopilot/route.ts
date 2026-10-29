import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { autopilotAvailable, CONSENT_TEXT, CONSENT_VERSION, disable, enable, getState, pause, recentAutopilotAudit, resume, WARMUP_SENDS, MAX_DAILY } from '@/lib/outreach/autopilot'
import { OutreachError } from '@/lib/outreach/service'
import { sameOriginJson } from '@/lib/same-origin'
import { audited, denied } from '@/lib/workspace-access'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  return NextResponse.json({ available: autopilotAvailable(), state: getState(db, user.tenantId), consent: { version: CONSENT_VERSION, text: CONSENT_TEXT }, warmup: WARMUP_SENDS(), max_daily: MAX_DAILY, audit: recentAutopilotAudit(db, user.tenantId) })
}

const ERR: Record<string, string> = {
  consent_required: 'Read and accept every statement first.',
  sender_identity_missing: 'Add your sender name and mailing address first.',
  gmail_not_connected: 'Connect Gmail first.',
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = await denied(user, 'send'); if (no) return no
  const done = audited(user, 'autopilot.changed', 'autopilot')
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  const db = getScanDb()
  try {
    // Pause and turn off always work, even when the operator has switched autopilot off.
    if (body?.action === 'pause') pause(db, user.tenantId)
    else if (body?.action === 'disable') disable(db, user.tenantId)
    else if (!autopilotAvailable()) return NextResponse.json({ error: 'Autopilot is not available right now' }, { status: 404 })
    else if (body?.action === 'enable') enable(db, user.tenantId, { version: String(body.version ?? ''), attestations: Array.isArray(body.attestations) ? body.attestations.map(String) : [], daily_cap: Number(body.daily_cap) || undefined })
    else if (body?.action === 'resume') resume(db, user.tenantId)
    else return NextResponse.json({ error: 'Bad request' }, { status: 400 })
    return done({ ok: true, state: getState(db, user.tenantId) }, undefined, { action: body?.action })
  } catch (e) {
    if (e instanceof OutreachError) return NextResponse.json({ error: ERR[e.code] ?? 'Could not do that', code: e.code }, { status: 400 })
    throw e
  }
}
