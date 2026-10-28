import { NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { campaignDetail } from '@/lib/outreach/campaign-detail'

// One campaign (= one scan) for its page: the job, all its leads and all their emails. Read-only and owner-scoped; a
// scan that is missing or someone else's is the same 404.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const { id } = await params
  const d = /^[a-f0-9]{24}$/.test(id) ? campaignDetail(getScanDb(), user.id, id) : null
  if (!d) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(d)
}
