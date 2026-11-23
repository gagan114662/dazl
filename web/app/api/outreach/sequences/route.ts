import { schedulerReadiness } from '@/lib/outreach/scheduler-readiness'
import { tenantFreshness } from '@/lib/ops/scheduler-runs'
import {currentnessHeld} from '@/lib/outreach/currentness'
import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { approve, leadEvidenceState, testFixtureSend, OutreachError } from '@/lib/outreach/service'
import { createSequence, editSequenceStep, approveSequence, sequenceAnalytics, sequenceStatusByLead, sequenceStepsView, testAddresses, acceptAutoSequencePolicy, revokeAutoSequencePolicy, AUTO_SEQUENCE_POLICY, AUTO_SEQUENCE_POLICY_TEXT, autoSequencePolicyAccepted, setTestAddresses, SequenceError, resolveSequenceUncertain, resumeSequences } from '@/lib/outreach/sequences'
import { denied } from '@/lib/workspace-access'
import { audit } from '@/lib/audit-route'
import { autopilotAvailable, getState } from '@/lib/outreach/autopilot'
import { AUTOPILOT_BETA_TEXT } from '@/lib/beta'
import { displayStopReason } from '@/lib/outreach/lifecycle'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 })
  const db = getScanDb()
  const rows = db.prepare('SELECT id, message_id, lead_id, to_email, status, stop_reason FROM sequences WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200').all(user.tenantId) as { id: string; status: string; lead_id: string; message_id: string }[]
  const sequences = rows.map(s => ({ ...s, stop_reason: displayStopReason((s as { stop_reason?: string | null }).stop_reason), evidence_state: leadEvidenceState(db, user.tenantId, s.lead_id), currentness_held: (()=>{const m=db.prepare('SELECT to_email,test FROM outreach_messages WHERE id=? AND tenant_id=?').get(s.message_id,user.tenantId) as {to_email:string;test:number}|undefined;return !(m&&testFixtureSend(db,user.tenantId,m))&&currentnessHeld(db,user.tenantId,s.lead_id)})(), steps: sequenceStepsView(db, user.tenantId, s as { id: string; message_id: string; status: string }) }))
  const campaigns = db.prepare('SELECT DISTINCT j.id,j.query FROM scan_jobs j JOIN leads l ON l.scan_job_id = j.id JOIN outreach_messages m ON m.lead_id = l.id AND m.tenant_id = j.user_id WHERE j.user_id = ? ORDER BY j.created_at DESC LIMIT 50').all(user.tenantId) as { id: string; query: string }[]
  const { scheduler, gates } = schedulerReadiness(db, user.tenantId)
  // #1620: automatic sequences only ever follow an autopilot first email, so while autopilot is not available the policy is
  // not offered at all. An account that accepted it earlier is told so (accepted, not available) and can still clear it.
  const available = autopilotAvailable(), accepted = autoSequencePolicyAccepted(db, user.tenantId)
  const auto_policy = available ? { version: AUTO_SEQUENCE_POLICY, text: AUTO_SEQUENCE_POLICY_TEXT, accepted, available } : accepted ? { version: AUTO_SEQUENCE_POLICY, text: [], accepted, available } : undefined
  // scheduler/gates: configuration. freshness: whether the scheduler is actually making progress for this tenant (its own rows only).
  return NextResponse.json({ scheduler, gates, freshness: await tenantFreshness(db, user.tenantId), sequences, test_addresses: testAddresses(db,user.tenantId), auto_policy, status: Object.fromEntries(sequenceStatusByLead(db,user.tenantId)), campaigns: campaigns.map(c => ({ ...c, analytics: sequenceAnalytics(db,user.tenantId,(db.prepare('SELECT id FROM leads WHERE scan_job_id = ?').all(c.id) as { id: string }[]).map(l => l.id)) })) })

}
export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 })
  const no = denied(user, 'send'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!(await rateLimit(`sequences:${user.tenantId}`,30,3600000)).ok) return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429 })
  const b = await req.json().catch(() => null)
  const db = getScanDb()
  try {
    // #1620: refused while autopilot is not available, whatever a page shows; turning it off (revoke) always works.
    if (b?.action === 'accept_auto_policy' && !autopilotAvailable()) return NextResponse.json({ error: AUTOPILOT_BETA_TEXT, code: 'autopilot_unavailable' }, { status: 404 })
    if (b?.action === 'accept_auto_policy' && typeof b.version === 'string') { acceptAutoSequencePolicy(db, user.tenantId, b.version); return NextResponse.json({ ok: true, version: AUTO_SEQUENCE_POLICY }) }
    if (b?.action === 'revoke_auto_policy') { revokeAutoSequencePolicy(db, user.tenantId); return NextResponse.json({ ok: true, accepted: false }) }
    if (b?.action === 'test_addresses' && Array.isArray(b.addresses) && b.addresses.every((v: unknown) => typeof v === 'string')) return NextResponse.json({ addresses: setTestAddresses(db,user.tenantId,b.addresses) })
    if (b?.action === 'create' && typeof b.message_id === 'string') {
      const id = createSequence(db,user.tenantId,b.message_id,{ businessName: user.business_name })
      // Template-only preparation. Creating a sequence never bills a provider key.
      // AI rewriting must be a separate, explicitly priced user action.
      return NextResponse.json({ id })
    }
    if (b?.action === 'resume') {
      // resuming an account that is not paused changes nothing, so it records nothing
      const before = getState(db, user.tenantId)
      resumeSequences(db,user.tenantId)
      if (before.paused || before.pause_reason !== null) await audit(user, req, { action: 'sequence.resumed', resource: 'sequences' })
      return NextResponse.json({ ok: true })
    }
    if (typeof b?.id !== 'string') return NextResponse.json({ error: 'Bad request' }, { status: 400 })
    if (b.action === 'approve') approveSequence(db,user.tenantId,b.id,id => approve(db,user.tenantId,id,true))
    else if (b.action === 'edit' && typeof b.subject === 'string' && typeof b.body === 'string') editSequenceStep(db,user.tenantId,b.id,b.step,{ subject: b.subject, body: b.body })
    else if ((b.action === 'mark_sent' || b.action === 'retry') && Number.isInteger(b.step)) resolveSequenceUncertain(db,user.tenantId,b.id,b.step,b.action === 'mark_sent' ? 'sent' : 'retry')
    else if (b.action === 'stop') {
      // stopping a sequence that is not running (or is not this workspace's) changes nothing, so it records nothing
      if (db.prepare("UPDATE sequences SET status = 'stopped', stop_reason = 'user_stopped' WHERE id = ? AND tenant_id = ? AND status IN ('draft','approved','active')").run(b.id,user.tenantId).changes === 0) return db.prepare('SELECT 1 FROM sequences WHERE id = ? AND tenant_id = ?').get(b.id,user.tenantId) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'not_found' }, { status: 404 }) // #830
    }
    else return NextResponse.json({ error: 'Bad request' }, { status: 400 })
    // approving schedules automated sends; stop, mark sent and retry change what the tick will send (edits are content)
    if (b.action !== 'edit') await audit(user, req, { action: `sequence.${b.action}`, resource: 'sequence', id: b.id, summary: Number.isInteger(b.step) ? { step: b.step } : undefined })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof SequenceError || e instanceof OutreachError) return NextResponse.json({ error: e.code }, { status: e.code === 'not_found' ? 404 : e.code === 'recipient_provenance_missing' ? 409 : 400 }) // #830: not this workspace's draft or sequence
    throw e
  }
}
