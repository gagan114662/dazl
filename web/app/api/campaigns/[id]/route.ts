import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { campaignDetail } from '@/lib/outreach/campaign-detail'
import { recordedEmptyReason } from '@/lib/scan/outcome-detail'
import { readPlayOffer, setPlayOffer } from '@/lib/scan/play-offer'
import { sameOriginJson } from '@/lib/same-origin'

// One campaign (= one scan) for its page: the job, all its leads and all their emails, and the offer this play is for
// (lib/scan/play-offer.ts). Read-only and owner-scoped; a scan that is missing or someone else's is the same 404.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const { id } = await params
  const db = await getDb()
  const d = /^[a-f0-9]{24}$/.test(id) ? await campaignDetail(db, user.id, id) : null
  if (!d) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ...d, job: { ...d.job, empty_reason: await recordedEmptyReason(db, user.id, d.job) }, offer: await readPlayOffer(db, user.id, id) })
}

// Choose what this play sells: { offer }. Only this play changes; the business profile and every other play keep
// theirs. Owner-scoped; someone else's play is the same 404.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const { id } = await params
  const body = await req.json().catch(() => null)
  if (typeof body?.offer !== 'string' || body.offer.replace(/\s+/g, ' ').trim().length < 3) return NextResponse.json({ error: 'Say in a few words what you sell for this play' }, { status: 400 })
  const db = await getDb()
  if (!/^[a-f0-9]{24}$/.test(id) || !(await setPlayOffer(db, user.id, id, body.offer))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ offer: await readPlayOffer(db, user.id, id) })
}
