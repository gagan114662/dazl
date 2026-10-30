import { schedulerReadiness } from '@/lib/outreach/scheduler-readiness'
import {currentnessHeld} from '@/lib/outreach/currentness'
import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { approve, leadEvidenceState, testFixtureSend, OutreachError } from '@/lib/outreach/service'
import { createSequence, editSequenceStep, approveSequence, sequenceAnalytics, sequenceStatusByLead, sequenceStepsView, testAddresses, setTestAddresses, SequenceError, resolveSequenceUncertain, resumeSequences } from '@/lib/outreach/sequences'
import { createSequenceTestFixture, createReplyStopTestFixture, fixtureAvailable, FixtureError } from '@/lib/outreach/test-fixture'
import { denied } from '@/lib/workspace-access'
import { audit } from '@/lib/audit-route'

export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 })
  const db = getScanDb()
  const rows = db.prepare('SELECT id, message_id, lead_id, to_email, status, stop_reason FROM sequences WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200').all(user.tenantId) as { id: string; status: string; lead_id: string; message_id: string }[]
  const sequences = rows.map(s => ({ ...s, evidence_state: leadEvidenceState(db, user.tenantId, s.lead_id), currentness_held: (()=>{const m=db.prepare('SELECT to_email,test FROM outreach_messages WHERE id=? AND tenant_id=?').get(s.message_id,user.tenantId) as {to_email:string;test:number}|undefined;return !(m&&testFixtureSend(db,user.tenantId,m))&&currentnessHeld(db,user.tenantId,s.lead_id)})(), steps: sequenceStepsView(db, user.tenantId, s as { id: string; message_id: string; status: string }) }))
  const campaigns = db.prepare('SELECT DISTINCT j.id,j.query FROM scan_jobs j JOIN leads l ON l.scan_job_id = j.id JOIN outreach_messages m ON m.lead_id = l.id AND m.tenant_id = j.user_id WHERE j.user_id = ? ORDER BY j.created_at DESC LIMIT 50').all(user.tenantId) as { id: string; query: string }[]
  const { scheduler, gates } = schedulerReadiness(db, user.tenantId)
  return NextResponse.json({ scheduler, gates, sequences, test_addresses: testAddresses(db,user.tenantId), test_fixture_available: fixtureAvailable(db,user.tenantId), status: Object.fromEntries(sequenceStatusByLead(db,user.tenantId)), campaigns: campaigns.map(c => ({ ...c, analytics: sequenceAnalytics(db,user.tenantId,(db.prepare('SELECT id FROM leads WHERE scan_job_id = ?').all(c.id) as { id: string }[]).map(l => l.id)) })) })
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
    if (b?.action === 'test_addresses' && Array.isArray(b.addresses) && b.addresses.every((v: unknown) => typeof v === 'string')) return NextResponse.json({ addresses: setTestAddresses(db,user.tenantId,b.addresses) })
    if (b?.action === 'create' && typeof b.message_id === 'string') {
      const id = createSequence(db,user.tenantId,b.message_id,{ businessName: user.business_name })
      // Template-only preparation. Creating a sequence never bills a provider key.
      // AI rewriting must be a separate, explicitly priced user action.
      return NextResponse.json({ id })
    }
    if (b?.action === 'create_test_fixture') return NextResponse.json(createSequenceTestFixture(db,user.tenantId))
    if (b?.action === 'create_reply_stop_fixture') return NextResponse.json(createReplyStopTestFixture(db,user.tenantId))
    if (b?.action === 'resume') { resumeSequences(db,user.tenantId); await audit(user, req, { action: 'sequence.resumed', resource: 'sequences' }); return NextResponse.json({ ok: true }) }
    if (typeof b?.id !== 'string') return NextResponse.json({ error: 'Bad request' }, { status: 400 })
    if (b.action === 'approve') approveSequence(db,user.tenantId,b.id,id => approve(db,user.tenantId,id,true))
    else if (b.action === 'edit' && typeof b.subject === 'string' && typeof b.body === 'string') editSequenceStep(db,user.tenantId,b.id,b.step,{ subject: b.subject, body: b.body })
    else if ((b.action === 'mark_sent' || b.action === 'retry') && Number.isInteger(b.step)) resolveSequenceUncertain(db,user.tenantId,b.id,b.step,b.action === 'mark_sent' ? 'sent' : 'retry')
    else if (b.action === 'stop') {
      // stopping a sequence that is not running (or is not this workspace's) changes nothing, so it records nothing
      if (db.prepare("UPDATE sequences SET status = 'stopped', stop_reason = 'user_stopped' WHERE id = ? AND tenant_id = ? AND status IN ('draft','approved','active')").run(b.id,user.tenantId).changes === 0) return NextResponse.json({ ok: true })
    }
    else return NextResponse.json({ error: 'Bad request' }, { status: 400 })
    // approving schedules automated sends; stop, mark sent and retry change what the tick will send (edits are content)
    if (b.action !== 'edit') await audit(user, req, { action: `sequence.${b.action}`, resource: 'sequence', id: b.id, summary: Number.isInteger(b.step) ? { step: b.step } : undefined })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof SequenceError || e instanceof OutreachError || e instanceof FixtureError) return NextResponse.json({ error: e.code }, { status: 400 })
    throw e
  }
}
