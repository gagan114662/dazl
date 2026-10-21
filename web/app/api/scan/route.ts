import { after, NextRequest, NextResponse } from 'next/server'
import { cleanText } from '@/lib/validate'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { MAX_QUERY, normalizeIcp } from '@/lib/scan/icp'
import { countActiveJobs, createJob, createQueryJob } from '@/lib/scan/store'
import { hasKey } from '@/lib/llm/key-store'
import { scanQuota } from '@/lib/plans'
import { normalizeSources } from '@/lib/sources'
import { kickRunner } from '@/lib/scan/runner'
import { recordTrialScan, trialStatus } from '@/lib/scan/trial'
import { getAuthDb, sellerProfile } from '@/lib/auth-db'

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
  // Keyless accounts fall back to the shared trial key: 3 scans per account, throttled per IP
  // per day. With no trial configured, queuing a keyless job would hang forever and burn a scan.
  let funded: 'user' | 'trial' = 'user'
  const ip = clientIp(req)
  if (!hasKey(db, user.id)) {
    const t = trialStatus(db, user.id, ip)
    if (!t.funded) {
      if (t.reason === 'account_cap' || t.reason === 'ip_throttle') {
        return NextResponse.json({ error: 'trial_exhausted', used: t.used }, { status: 402 })
      }
      return NextResponse.json({ error: 'no_api_key' }, { status: 400 })
    }
    funded = 'trial'
  }
  if (countActiveJobs(db, user.id) >= 2) {
    return NextResponse.json({ error: 'You already have scans in progress. Wait for them to finish.' }, { status: 429 })
  }
  const q = scanQuota(db, user.id)
  if (!q.allowed) {
    return NextResponse.json({ error: 'quota_exceeded', plan: q.plan, used: q.used, limit: q.limit }, { status: 402 })
  }
  const sel = body?.sources ? normalizeSources(body.sources) : null
  const job_id = query.length >= 3 ? createQueryJob(db, user.id, { query, icp: icp ? JSON.stringify(icp) : null, sources: sel ? JSON.stringify(sel) : null, seller: sellerProfile(getAuthDb(), user.id) }) : createJob(db, user.id, { business_name, industry, location })
  if (funded === 'trial') {
    db.prepare("UPDATE scan_jobs SET funded_by = 'trial' WHERE id = ?").run(job_id)
    recordTrialScan(db, user.id, job_id, ip)
  }
  after(() => kickRunner(db))
  return NextResponse.json({ job_id }, { status: 202 })
}
