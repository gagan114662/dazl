import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { audit } from '@/lib/audit-route'
import { denied } from '@/lib/workspace-access'
import type { Action } from '@/lib/workspaces'
import { explainAccount, FeedbackError, recordFeedback, resetFeedback } from '@/lib/scan/feedback'

// Reasoned feedback on one lead (#385, lib/scan/feedback.ts). GET explains every verdict (active and reset) that applies
// to this lead's account; POST records an explicit ACCEPT (a rejection goes through POST /quarantine with a
// feedback_reason, which also quarantines); DELETE resets one verdict by id, with why (the row stays as history).
// Tenant-scoped: another tenant's lead or feedback id is unknown here.

const LEAD = /^[a-f0-9]{24}$/
type LeadRef = { company: string; company_domain: string | null }
async function ownLead(tenantId: string, leadId: string): Promise<LeadRef | undefined> {
  if (!LEAD.test(leadId)) return undefined
  return (await getDb()).get<LeadRef>('SELECT l.company, l.company_domain FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?', [leadId, tenantId])
}

async function guard(req: NextRequest, lead: string, action: Action) {
  const user = await requireUser()
  if (!user) return { res: NextResponse.json({ error: 'Not signed in' }, { status: 401 }) }
  const no = denied(user, action)
  if (no) return { res: no }
  if (!sameOriginJson(req)) return { res: NextResponse.json({ error: 'Bad origin' }, { status: 403 }) }
  if (!LEAD.test(lead)) return { res: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  if (!(await rateLimit(`lead-feedback:${user.tenantId}`, 60, 60_000)).ok) return { res: NextResponse.json({ error: 'Too many requests' }, { status: 429 }) }
  const raw: unknown = await req.json().catch(() => ({}))
  return { user, body: (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown> }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ lead: string }> }) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const { lead } = await params
  const l = await ownLead(user.tenantId, lead)
  if (!l) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const rows = await explainAccount(await getDb(), user.tenantId, l)
  return NextResponse.json({ feedback: rows.map(r => ({ id: r.id, version: r.version, verdict: r.verdict, level: r.level, reason: r.reason, lead_id: r.lead_id, event_date: r.event_date, note: r.note, created_at: r.created_at, reset_at: r.reset_at, reset_reason: r.reset_reason })) })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ lead: string }> }) {
  const { lead } = await params
  const g = await guard(req, lead, 'operate')
  if (g.res) return g.res
  if (g.body.verdict !== 'accept') return NextResponse.json({ error: 'invalid_verdict', detail: 'POST records an acceptance; reject through /quarantine with a feedback_reason' }, { status: 400 })
  try {
    const row = await recordFeedback(await getDb(), g.user!.tenantId, lead, { verdict: 'accept', note: g.body.note, actorId: g.user!.actorId })
    await audit(g.user!, req, { action: 'pipeline.accepted', resource: 'lead', id: lead, summary: { version: row.version } })
    return NextResponse.json({ feedback: { id: row.id, version: row.version, verdict: row.verdict, level: row.level } })
  } catch (e) {
    if (e instanceof FeedbackError) return NextResponse.json({ error: e.code === 'not_found' ? 'Not found' : e.code, detail: e.message }, { status: e.code === 'not_found' ? 404 : 400 })
    throw e
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ lead: string }> }) {
  const { lead } = await params
  const g = await guard(req, lead, 'operate')
  if (g.res) return g.res
  if (!(await ownLead(g.user!.tenantId, lead))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (typeof g.body.id !== 'string' || !g.body.id) return NextResponse.json({ error: 'id_required' }, { status: 400 })
  try {
    const ok = await resetFeedback(await getDb(), g.user!.tenantId, g.body.id, g.body.reason)
    if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    await audit(g.user!, req, { action: 'pipeline.feedback_reset', resource: 'lead', id: lead })
    return NextResponse.json({ reset: true })
  } catch (e) {
    if (e instanceof FeedbackError) return NextResponse.json({ error: e.code, detail: e.message }, { status: 400 })
    throw e
  }
}
