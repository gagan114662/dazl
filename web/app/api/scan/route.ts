import { after, NextRequest, NextResponse } from 'next/server'
import { cleanText } from '@/lib/validate'
import { rateLimit } from '@/lib/rate-limit'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { countActiveJobs, createJob } from '@/lib/scan/store'
import { scanQuota } from '@/lib/plans'
import { kickRunner } from '@/lib/scan/runner'

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })

  const rl = rateLimit(`scan:${user.id}`, 10, 60 * 60 * 1000)
  if (!rl.ok) return NextResponse.json({ error: 'Too many scans. Try again later.' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterS) } })

  const body = await req.json().catch(() => null)
  const business_name = cleanText(body?.business_name, 150)
  const industry = cleanText(body?.industry, 100)
  const location = cleanText(body?.location, 100)
  if (!business_name || !industry || !location) {
    return NextResponse.json({ error: 'business_name, industry and location are required' }, { status: 400 })
  }

  const db = getScanDb()
  if (countActiveJobs(db, user.id) >= 2) {
    return NextResponse.json({ error: 'You already have scans in progress. Wait for them to finish.' }, { status: 429 })
  }
  const q = scanQuota(db, user.id)
  if (!q.allowed) {
    return NextResponse.json({ error: 'quota_exceeded', plan: q.plan, used: q.used, limit: q.limit }, { status: 402 })
  }
  const job_id = createJob(db, user.id, { business_name, industry, location })
  after(() => kickRunner(db))
  return NextResponse.json({ job_id }, { status: 202 })
}
