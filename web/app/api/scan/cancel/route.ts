import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { cancelJob } from '@/lib/scan/store'
import { sameOriginJson } from '@/lib/same-origin'

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  if (typeof body?.job_id !== 'string' || !/^[a-f0-9]{24}$/.test(body.job_id)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const r = cancelJob(getScanDb(), user.id, body.job_id)
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.reason === 'not_found' ? 404 : 409 })
  return NextResponse.json({ cancelled: true, provider_work_stopped: false, note: r.was_running ? 'Stop requested. No new steps will start and results are discarded, but the step already running (it can include several provider and page calls) may continue for a while and still be billed. This scan holds its slot for a few minutes.' : 'Cancelled before it started.' })
}
