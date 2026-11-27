import { tenantReadDenied } from '@/lib/tenant/read-denial'
import { readQueuedWebsiteApproval } from '@/lib/scan/website-profile-provenance'
import { after, NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { getJob } from '@/lib/scan/store'
import { kickRunner } from '@/lib/scan/runner'
import { sqliteDb } from '@/lib/db/client'
import { readScanStatus } from '@/lib/scan/status-read-service'

export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const jobId = req.nextUrl.searchParams.get('job_id') ?? ''
  const raw = getScanDb()
  // readonly=1 skips the job reap and the runner dispatch, and the domain reader (readScanStatus) only SELECTs
  // (#1006: a read-only status surface for a terminal job). It is NOT a no-change endpoint: authentication can
  // update the caller's own session metadata (throttled last_seen, as on every authenticated request), and first-use
  // database initialization can write schema and data. Ordinary pollers (no readonly) keep the legacy reap +
  // dispatch semantics below, unchanged. This comment documents behavior only.
  if (req.nextUrl.searchParams.get('readonly') === '1') {
    const payload = /^[a-f0-9]{24}$/.test(jobId) ? await readScanStatus(sqliteDb(raw), user.tenantId, jobId) : null
    if (payload && readQueuedWebsiteApproval(raw, user.tenantId, jobId)) Object.assign(payload, { website_profile_review: 'confirmed' })
    return payload ? NextResponse.json(payload) : tenantReadDenied('Not found')
  }
  // Legacy getJob reaps before the owner read. Preserve that behavior and runner dispatch on this SAME raw scan store.
  const job = /^[a-f0-9]{24}$/.test(jobId) ? getJob(raw, user.tenantId, jobId) : undefined
  if (!job) return tenantReadDenied('Not found')
  if (job.status === 'pending' && req.nextUrl.searchParams.get('passive') !== '1') after(() => kickRunner(raw))
  const payload = await readScanStatus(sqliteDb(raw), user.tenantId, jobId)
  if (payload && readQueuedWebsiteApproval(raw, user.tenantId, jobId)) Object.assign(payload, { website_profile_review: 'confirmed' })
  return payload ? NextResponse.json(payload) : tenantReadDenied('Not found')
}
