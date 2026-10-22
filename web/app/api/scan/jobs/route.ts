import { NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { listJobs } from '@/lib/scan/store'

// The leads page history list: the signed-in tenant's own past scans so a returning
// user can explicitly pick one. Read-only; same tenant scoping as every other scan read.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const jobs = listJobs(getScanDb(), user.id).map(j => ({
    ...j,
    // Fixture jobs are inserted with a '(test only)' business name; label them so the
    // history list never presents test rows as real scan results.
    test_only: j.business_name.endsWith('(test only)'),
  }))
  return NextResponse.json({ jobs })
}
