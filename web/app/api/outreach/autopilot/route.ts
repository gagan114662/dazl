import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { autopilotAvailable, CONSENT_TEXT, CONSENT_VERSION, disable, enable, getState, pause, recentAutopilotAudit, resume, WARMUP_SENDS, MAX_DAILY } from '@/lib/outreach/autopilot'
import { OutreachError } from '@/lib/outreach/service'
import { sameOriginJson } from '@/lib/same-origin'
import { denied } from '@/lib/workspace-access'
import { acceptLaunchPolicy, LAUNCH_POLICY_VERSION, launchPolicyView } from '@/lib/outreach/launch-policy'
import { runCalibration } from '@/lib/outreach/calibration'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  return NextResponse.json({ available: autopilotAvailable(), state: getState(db, user.tenantId), consent: { version: CONSENT_VERSION, text: CONSENT_TEXT }, warmup: WARMUP_SENDS(), max_daily: MAX_DAILY, audit: recentAutopilotAudit(db, user.tenantId), launch: { version: LAUNCH_POLICY_VERSION, ...launchPolicyView(db, user.tenantId) } })
}

const ERR: Record<string, string> = {
  consent_required: 'Read and accept every statement first.',
  sender_identity_missing: 'Add your sender name and mailing address first.',
  gmail_not_connected: 'Connect Gmail first.',
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'send'); if (no) return no
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
    // Calibrated launch (#405): accept one explicit launch policy, then run the machine preflight against it. Only a
    // passing preflight replaces the hand-approval warmup; accepting a new policy always needs a new passing run.
    else if (body?.action === 'accept_launch_policy') {
      const r = acceptLaunchPolicy(db, user.tenantId, body.policy, Math.floor(Date.now() / 1000))
      if (!r.ok) return NextResponse.json({ error: 'The launch policy is incomplete', problems: r.problems }, { status: 400 })
    }
    else if (body?.action === 'launch_calibrated') {
      const r = await runCalibration(db, user.tenantId, user.business_name)
      return NextResponse.json({ ok: r.ok, preflight: r, state: getState(db, user.tenantId) }, { status: r.ok ? 200 : 409 })
    }
    else return NextResponse.json({ error: 'Bad request' }, { status: 400 })
    return NextResponse.json({ ok: true, state: getState(db, user.tenantId) })
  } catch (e) {
    if (e instanceof OutreachError) return NextResponse.json({ error: ERR[e.code] ?? 'Could not do that', code: e.code }, { status: 400 })
    throw e
  }
}
