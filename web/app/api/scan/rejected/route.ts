import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { readRunReport } from '@/lib/scan/run-report'
import { listFeedback } from '@/lib/scan/feedback'
import { leftOutSummary, rejectedLeftOut } from '@/lib/scan/rejected-drops'

// #754: which companies this scan left out because the tenant rejected them, with the reason and the lead to undo
// from (DELETE /api/leads/<lead_id>/feedback {id}). Owner-scoped: another tenant's job is Not found. Read only.
export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const jobId = req.nextUrl.searchParams.get('job_id') ?? ''
  if (!/^[a-f0-9]{24}$/.test(jobId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const db = await getDb()
  const own = await db.get<{ id: string }>('SELECT id FROM scan_jobs WHERE id = ? AND user_id = ?', [jobId, user.tenantId])
  if (!own) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const reports = await readRunReport(db, user.tenantId, jobId)
  let active: { id: string; lead_id: string | null; reason: string | null }[] = []
  try { active = await listFeedback(db, user.tenantId, { activeOnly: true }) } catch { active = [] }
  const rejected = rejectedLeftOut(reports, active)
  return NextResponse.json({ rejected, summary: leftOutSummary(rejected) })
}
