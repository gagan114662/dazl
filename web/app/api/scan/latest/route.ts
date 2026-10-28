import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { latestQueryJob } from '@/lib/scan/store-db'

// The leads page restores the tenant's last profile from this, so a reload never loses it.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const job = await latestQueryJob(await getDb(), user.id)
  if (!job) return NextResponse.json({ query: null, icp: null, icp_source: null })
  return NextResponse.json({ query: job.query, icp: job.icp ? JSON.parse(job.icp) : null, icp_source: job.icp_inferred === 1 ? 'inferred' : job.icp_inferred === 2 ? 'request_only' : job.icp_inferred === 0 ? 'user' : null })
}
