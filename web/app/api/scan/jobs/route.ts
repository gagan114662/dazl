import { NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { historyJobs } from '@/lib/scan/history-jobs'

// The leads page history list: the signed-in tenant's own past scans so a returning
// user can explicitly pick one. Read-only; same tenant scoping as every other scan read.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  return NextResponse.json({ jobs: historyJobs(getScanDb(), user.id) })
}
