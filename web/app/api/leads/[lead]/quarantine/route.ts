import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { setQuarantine } from '@/lib/scan/quarantine'
import { FeedbackError, isRejectReason, rejectLead, releaseLead } from '@/lib/scan/feedback'
import { audit } from '@/lib/audit-route'
import { denied } from '@/lib/workspace-access'
import type { Action } from '@/lib/workspaces'

// Quarantine a lead (wrong company, wrong contact details): kept with all its evidence, but never drafted, sent,
// picked by autopilot or exported. DELETE releases it. Reversible; nothing is deleted.
// With a structured `feedback_reason` (#385, lib/scan/feedback.ts) the rejection is also learned: later runs do not bring
// the account / person / event back. Validated before anything changes (400, nothing quarantined, nothing recorded);
// quarantine and feedback are one transaction. Without one, the lead is quarantined and nothing is learned (hiding is not
// a reasoned label). DELETE also resets what that lead's rejection taught (the rows stay as history).

async function guard(req: NextRequest, leadId: string, action: Action) {
  const user = await requireUser()
  if (!user) return { res: NextResponse.json({ error: 'Not signed in' }, { status: 401 }) }
  const no = denied(user, action)
  if (no) return { res: no }
  if (!sameOriginJson(req)) return { res: NextResponse.json({ error: 'Bad origin' }, { status: 403 }) }
  if (!/^[a-f0-9]{24}$/.test(leadId)) return { res: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  if (!(await rateLimit(`quarantine-lead:${user.tenantId}`, 60, 60_000)).ok) return { res: NextResponse.json({ error: 'Too many requests' }, { status: 429 }) }
  return { user }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ lead: string }> }) {
  const { lead } = await params
  const g = await guard(req, lead, 'operate')
  if (g.res) return g.res
  const raw: unknown = await req.json().catch(() => ({}))
  const body = (raw && typeof raw === 'object' ? raw : {}) as { reason?: unknown; feedback_reason?: unknown; person?: unknown }
  const typed = typeof body.reason === 'string' ? body.reason : ''
  if ('feedback_reason' in body && !isRejectReason(body.feedback_reason)) return NextResponse.json({ error: 'invalid_feedback_reason' }, { status: 400 })
  if (body.person !== undefined && typeof body.person !== 'string') return NextResponse.json({ error: 'invalid_person' }, { status: 400 })
  let feedback: { id: string; level: string; reason: string | null; version: number } | null = null
  if (isRejectReason(body.feedback_reason)) {
    try {
      const r = await rejectLead(await getDb(), g.user!.tenantId, lead, { reason: body.feedback_reason, person: body.person, note: typed, quarantineReason: typed, actorId: g.user!.actorId })
      if (r.status === 'not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 })
      feedback = { id: r.feedback.id, level: r.feedback.level, reason: r.feedback.reason, version: r.feedback.version }
    } catch (e) {
      if (e instanceof FeedbackError) return NextResponse.json({ error: e.code, detail: e.message }, { status: 400 })
      throw e
    }
  } else {
    const r = await setQuarantine(await getDb(), g.user!.tenantId, lead, 'quarantine', typed)
    if (r.status === 'not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  // the typed reason is the user's own text: the trail records only that one was given (and the structured code, if any)
  await audit(g.user!, req, { action: 'pipeline.quarantined', resource: 'lead', id: lead, summary: { with_reason: typed.trim() !== '', ...(feedback ? { feedback_reason: feedback.reason, feedback_level: feedback.level } : {}) } })
  return NextResponse.json({ quarantined: true, feedback })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ lead: string }> }) {
  const { lead } = await params
  const g = await guard(req, lead, 'operate')
  if (g.res) return g.res
  const r = await releaseLead(await getDb(), g.user!.tenantId, lead)
  if (r.status === 'not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // releasing a lead that is not quarantined changes nothing, so it records nothing
  if (r.status === 'released') await audit(g.user!, req, { action: 'pipeline.released', resource: 'lead', id: lead, summary: { feedback_reset: r.reset } })
  return NextResponse.json({ quarantined: false, feedback_reset: r.status === 'released' ? r.reset : 0 })
}
