import { NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { listJobs } from '@/lib/scan/store'
import { effectiveStatus } from '@/lib/scan/enrichment'
import { recordedEmptyReason } from '@/lib/scan/outcome-detail'

// The leads page history list: the signed-in tenant's own past scans so a returning
// user can explicitly pick one. Read-only; same tenant scoping as every other scan read.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  // Who paid for each scan, so a rejected key is attributed honestly: the shared free-search key ('trial') or the
  // account's own key ('user'). Owner-scoped read only.
  const trial = new Set((db.prepare("SELECT id FROM scan_jobs WHERE user_id = ? AND funded_by = 'trial'").all(user.id) as { id: string }[]).map(r => r.id))
  const jobs = listJobs(db, user.id).map(j => ({
    ...j,
    funded_by: trial.has(j.id) ? 'trial' : 'user',
    status: effectiveStatus(j),
    // Why a scan extracted nothing, as recorded (counts only); null when not recorded or not that outcome.
    empty_reason: recordedEmptyReason(db, user.id, j),
    // Fixture jobs carry the inserters' own job-level marker (industry/location
    // 'test only') - the same provenance the export filter uses - so a genuine
    // business whose name contains '(test only)' is never mislabeled or hidden.
    test_only: j.industry === 'test only' && j.location === 'test only',
  }))
  return NextResponse.json({ jobs })
}
