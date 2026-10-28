import { NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { listJobs } from '@/lib/scan/store'
import { scanOutcome, reportSummaries } from '@/lib/scan/outcome'
import { effectiveStatus } from '@/lib/scan/enrichment'

// The leads page history list: the signed-in tenant's own past scans so a returning
// user can explicitly pick one. Read-only; same tenant scoping as every other scan read.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const rows = listJobs(getScanDb(), user.id)
  const sums = reportSummaries(getScanDb(), user.id, rows.map(j => j.id))
  const jobs = rows.map(j => ({
    ...j,
    status: effectiveStatus(j),
    outcome: scanOutcome(j as never, sums.get(j.id) ?? null),
    // Fixture jobs carry the inserters' own job-level marker (industry/location
    // 'test only') - the same provenance the export filter uses - so a genuine
    // business whose name contains '(test only)' is never mislabeled or hidden.
    test_only: j.industry === 'test only' && j.location === 'test only',
  }))
  return NextResponse.json({ jobs })
}
