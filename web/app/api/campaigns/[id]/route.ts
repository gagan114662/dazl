import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { campaignDetail } from '@/lib/outreach/campaign-detail'
import { recordedEmptyReason } from '@/lib/scan/outcome-detail'

// One campaign (= one scan) for its page: the job, all its leads and all their emails. Read-only and owner-scoped; a
// scan that is missing or someone else's is the same 404.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const { id } = await params
  const db = await getDb()
  const d = /^[a-f0-9]{24}$/.test(id) ? await campaignDetail(db, user.tenantId, id) : null
  if (!d) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ...d, job: { ...d.job, empty_reason: await recordedEmptyReason(db, user.tenantId, d.job) } })
}
