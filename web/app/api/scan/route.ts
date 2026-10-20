import { after, NextRequest, NextResponse } from 'next/server'
import { cleanText } from '@/lib/validate'
import { rateLimit } from '@/lib/rate-limit'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { MAX_QUERY, normalizeIcp } from '@/lib/scan/icp'
import { countActiveJobs, createJob, createQueryJob } from '@/lib/scan/store'
import { scanQuota } from '@/lib/plans'
import { kickRunner } from '@/lib/scan/runner'

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })

  const rl = rateLimit(`scan:${user.id}`, 10, 60 * 60 * 1000)
  if (!rl.ok) return NextResponse.json({ error: 'Too many scans. Try again later.' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterS) } })

  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  // Preferred input: free text, plus an optional profile the user already reviewed or edited.
  const query = cleanText(body?.query, MAX_QUERY)
  const icp = body?.icp === undefined || body?.icp === null ? null : normalizeIcp(body.icp)
  if (body?.icp !== undefined && body?.icp !== null && !icp) return NextResponse.json({ error: 'The profile needs a summary' }, { status: 400 })
  // Legacy input, still accepted for older clients.
  const business_name = cleanText(body?.business_name, 150)
  const industry = cleanText(body?.industry, 100)
  const location = cleanText(body?.location, 100)
  if (query.length < 3 && (!business_name || !industry || !location)) {
    return NextResponse.json({ error: 'Describe who you are looking for' }, { status: 400 })
  }

  const db = getScanDb()
  if (countActiveJobs(db, user.id) >= 2) {
    return NextResponse.json({ error: 'You already have scans in progress. Wait for them to finish.' }, { status: 429 })
  }
  const q = scanQuota(db, user.id)
  if (!q.allowed) {
    return NextResponse.json({ error: 'quota_exceeded', plan: q.plan, used: q.used, limit: q.limit }, { status: 402 })
  }
  const job_id = query.length >= 3 ? createQueryJob(db, user.id, { query, icp: icp ? JSON.stringify(icp) : null }) : createJob(db, user.id, { business_name, industry, location })
  after(() => kickRunner(db))
  return NextResponse.json({ job_id }, { status: 202 })
}
