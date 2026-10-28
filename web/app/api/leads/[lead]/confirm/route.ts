import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { confirmLeadReview, unconfirmLeadReview } from '@/lib/scan/review-confirm'

// Human confirmation of a needs-review lead. The machine verdict is untouched: this
// records that the USER checked the source and chose to use the lead, which makes it
// draft-eligible under an explicit "confirmed by you" label. DELETE withdraws the
// confirmation and restores the exact original review reason.

async function guard(req: NextRequest, leadId: string) {
  const user = await requireUser()
  if (!user) return { res: NextResponse.json({ error: 'Not signed in' }, { status: 401 }) }
  if (!sameOriginJson(req)) return { res: NextResponse.json({ error: 'Bad origin' }, { status: 403 }) }
  if (!/^[a-f0-9]{24}$/.test(leadId)) return { res: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  return { user }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ lead: string }> }) {
  const { lead } = await params
  const g = await guard(req, lead)
  if (g.res) return g.res
  if (!(await rateLimit(`confirm-lead:${g.user!.id}`, 60, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const confirmed = confirmLeadReview(getScanDb(), g.user!.id, lead)
  if (!confirmed) return NextResponse.json({ error: 'Lead not found in your review list' }, { status: 404 })
  return NextResponse.json({ confirmed: true })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ lead: string }> }) {
  const { lead } = await params
  const g = await guard(req, lead)
  if (g.res) return g.res
  if (!(await rateLimit(`confirm-lead:${g.user!.id}`, 60, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const withdrawn = unconfirmLeadReview(getScanDb(), g.user!.id, lead)
  if (!withdrawn) return NextResponse.json({ error: 'No confirmation to withdraw' }, { status: 404 })
  return NextResponse.json({ confirmed: false })
}
