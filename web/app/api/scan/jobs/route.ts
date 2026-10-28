import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { historyJobs, historyTotals } from '@/lib/scan/history-jobs'

// The leads page history list: the signed-in tenant's own past scans so a returning
// user can explicitly pick one. Read-only; same tenant scoping as every other scan read.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = await getDb()
  // totals: complete counts over all of the tenant's own searches (the jobs list is the newest 20 only).
  return NextResponse.json({ jobs: await historyJobs(db, user.id), totals: await historyTotals(db, user.id) })
}
