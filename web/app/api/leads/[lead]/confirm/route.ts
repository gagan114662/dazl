import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { confirmLeadReview, unconfirmLeadReview } from '@/lib/scan/review-confirm'
import { audit, denied } from '@/lib/workspace-access'
import type { Action } from '@/lib/workspaces'

// Human confirmation of a needs-review lead. The machine verdict is untouched: this
// records that the USER checked the source and chose to use the lead, which makes it
// draft-eligible under an explicit "confirmed by you" label. DELETE withdraws the
// confirmation and restores the exact original review reason.

async function guard(req: NextRequest, leadId: string, action: Action) {
  const user = await requireUser()
  if (!user) return { res: NextResponse.json({ error: 'Not signed in' }, { status: 401 }) }
  const no = await denied(user, action)
  if (no) return { res: no }
  if (!sameOriginJson(req)) return { res: NextResponse.json({ error: 'Bad origin' }, { status: 403 }) }
  if (!/^[a-f0-9]{24}$/.test(leadId)) return { res: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  return { user }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ lead: string }> }) {
  const { lead } = await params
  const g = await guard(req, lead, 'operate')
  if (g.res) return g.res
  if (!(await rateLimit(`confirm-lead:${g.user!.tenantId}`, 60, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const confirmed = await confirmLeadReview(await getDb(), g.user!.tenantId, lead)
  if (!confirmed) return NextResponse.json({ error: 'Lead not found in your review list' }, { status: 404 })
  await audit(g.user!, 'lead.confirmed', 'lead', lead)
  return NextResponse.json({ confirmed: true })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ lead: string }> }) {
  const { lead } = await params
  const g = await guard(req, lead, 'operate')
  if (g.res) return g.res
  if (!(await rateLimit(`confirm-lead:${g.user!.tenantId}`, 60, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const withdrawn = await unconfirmLeadReview(await getDb(), g.user!.tenantId, lead)
  if (!withdrawn) return NextResponse.json({ error: 'No confirmation to withdraw' }, { status: 404 })
  await audit(g.user!, 'lead.unconfirmed', 'lead', lead)
  return NextResponse.json({ confirmed: false })
}
