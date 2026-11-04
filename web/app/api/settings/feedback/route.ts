import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { audit } from '@/lib/audit-route'
import { denied } from '@/lib/workspace-access'
import { applyProposal, FeedbackError, listFeedback, proposeProfile, sourceYield, type ProfileProposal } from '@/lib/scan/feedback'

// What the tenant's explicit verdicts taught (#385, lib/scan/feedback.ts): GET returns the learned source yield (an
// ordering preference only) and a proposed memory change (competitor / existing-relationship rejections as named
// exclusions), computed against the memory and feedback versions it saw. POST applies that proposal, only while both
// versions are unchanged; nothing is applied by itself.

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = await getDb()
  return NextResponse.json({ source_yield: sourceYield(await listFeedback(db, user.tenantId, { activeOnly: true })), proposal: await proposeProfile(db, user.tenantId) })
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')
export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'configure'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null) as { proposal?: Partial<ProfileProposal> } | null
  const p = body?.proposal
  if (!p || typeof p.base_memory_version !== 'number' || typeof p.feedback_version !== 'number' || !strings(p.base_exclusions) || !strings(p.add_exclusions)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  try {
    const memory = await applyProposal(await getDb(), user.tenantId, { base_memory_version: p.base_memory_version, feedback_version: p.feedback_version, base_exclusions: p.base_exclusions, add_exclusions: p.add_exclusions, why: [] })
    await audit(user, req, { action: 'settings.changed', resource: 'memory', summary: { from_feedback: p.add_exclusions.length } })
    return NextResponse.json({ memory })
  } catch (e) {
    if (e instanceof FeedbackError) return NextResponse.json({ error: e.code, detail: e.message }, { status: 409 })
    throw e
  }
}
