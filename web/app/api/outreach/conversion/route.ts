import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { conversionReport } from '@/lib/outreach/conversion'
import { getDb } from '@/lib/db/client'
import { replyReadingOn } from '@/lib/outreach/reply-reading'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = await getDb()
  const reading = await replyReadingOn(db, user.tenantId)
  return NextResponse.json(await conversionReport(db, user.tenantId, reading))
}
