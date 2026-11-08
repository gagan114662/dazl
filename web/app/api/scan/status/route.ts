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
  // readonly=1: this request performs NO writes of its own - getJob's reap and the runner kick are both skipped and
  // readScanStatus only SELECTs, so it cannot write any job, source-run, report or ledger row (#1006: a read-only
  // status surface for a terminal job). Boundaries, stated exactly: authentication is the ordinary path, so the
  // caller's OWN session row may be touched (throttled last_seen, as on every authenticated request); and on a COLD
  // process the first DB open runs the one-time migrators, which can create schema and backfill scan-store rows -
  // existing process-startup behavior shared by every endpoint, not an effect of this request. Ordinary pollers
  // (no readonly) keep the legacy reap + dispatch semantics below, unchanged. This comment documents behavior only.
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
