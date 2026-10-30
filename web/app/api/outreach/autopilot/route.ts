import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { autopilotAvailable, CONSENT_TEXT, CONSENT_VERSION, disable, enable, getState, pause, recentAutopilotAudit, resume, WARMUP_SENDS, MAX_DAILY } from '@/lib/outreach/autopilot'
import { OutreachError } from '@/lib/outreach/service'
import { sameOriginJson } from '@/lib/same-origin'
import { audit } from '@/lib/audit-route'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  return NextResponse.json({ available: autopilotAvailable(), state: getState(db, user.id), consent: { version: CONSENT_VERSION, text: CONSENT_TEXT }, warmup: WARMUP_SENDS(), max_daily: MAX_DAILY, audit: recentAutopilotAudit(db, user.id) })
}

const ERR: Record<string, string> = {
  consent_required: 'Read and accept every statement first.',
  sender_identity_missing: 'Add your sender name and mailing address first.',
  gmail_not_connected: 'Connect Gmail first.',
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  const db = getScanDb()
  try {
    // Pause and turn off always work, even when the operator has switched autopilot off.
    if (body?.action === 'pause') pause(db, user.id)
    else if (body?.action === 'disable') disable(db, user.id)
    else if (!autopilotAvailable()) return NextResponse.json({ error: 'Autopilot is not available right now' }, { status: 404 })
    else if (body?.action === 'enable') enable(db, user.id, { version: String(body.version ?? ''), attestations: Array.isArray(body.attestations) ? body.attestations.map(String) : [], daily_cap: Number(body.daily_cap) || undefined })
    else if (body?.action === 'resume') resume(db, user.id)
    else return NextResponse.json({ error: 'Bad request' }, { status: 400 })
    // budget and send automation: the action, and the daily cap when one is set
    await audit(user, req, { action: `autopilot.${body.action}`, resource: 'autopilot', summary: body.action === 'enable' ? { daily_cap: Number(body.daily_cap) || null } : {} })
    return NextResponse.json({ ok: true, state: getState(db, user.id) })
  } catch (e) {
    if (e instanceof OutreachError) return NextResponse.json({ error: ERR[e.code] ?? 'Could not do that', code: e.code }, { status: 400 })
    throw e
  }
}
