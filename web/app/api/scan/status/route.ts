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
  // readonly=1: a pure read - getJob's reap and the runner kick are both skipped, so this request writes nothing
  // (#1006: a genuine read-only status surface for a terminal job). Same auth and tenant scoping; readScanStatus
  // reads only. Ordinary pollers (no readonly) keep the legacy reap + dispatch semantics below, unchanged.
  if (req.nextUrl.searchParams.get('readonly') === '1') {
    const payload = /^[a-f0-9]{24}$/.test(jobId) ? await readScanStatus(sqliteDb(raw), user.tenantId, jobId) : null
    return payload ? NextResponse.json(payload) : NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  // Legacy getJob reaps before the owner read. Preserve that behavior and runner dispatch on this SAME raw scan store.
  const job = /^[a-f0-9]{24}$/.test(jobId) ? getJob(raw, user.tenantId, jobId) : undefined
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (job.status === 'pending' && req.nextUrl.searchParams.get('passive') !== '1') after(() => kickRunner(raw))
  const payload = await readScanStatus(sqliteDb(raw), user.tenantId, jobId)
  return payload ? NextResponse.json(payload) : NextResponse.json({ error: 'Not found' }, { status: 404 })
}
