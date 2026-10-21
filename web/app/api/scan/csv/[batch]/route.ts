import { after, NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { getPlan } from '@/lib/plans'
import { hasKey } from '@/lib/llm/key-store'
import { kickRunner } from '@/lib/scan/runner'
import { batchStatus, queuePendingRows } from '@/lib/scan/csv-import'

async function load(req: NextRequest, batch: string) {
  const user = await requireUser()
  if (!user) return { res: NextResponse.json({ error: 'Not signed in' }, { status: 401 }) }
  if (!/^[a-f0-9]{24}$/.test(batch)) return { res: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  const status = batchStatus(getScanDb(), user.id, batch)
  if (!status) return { res: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  return { user, status }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ batch: string }> }) {
  const { batch } = await params
  const r = await load(req, batch)
  if ('res' in r) return r.res
  return NextResponse.json(r.status)
}

// Resume: queue jobs for rows the last attempt left pending (quota reached mid-batch).
// Failed jobs are not re-run - re-import the file to try those domains again.
export async function POST(req: NextRequest, { params }: { params: Promise<{ batch: string }> }) {
  const { batch } = await params
  const r = await load(req, batch)
  if ('res' in r) return r.res
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const rl = rateLimit(`csv-resume:${r.user.id}`, 20, 24 * 60 * 60 * 1000)
  if (!rl.ok) return NextResponse.json({ error: 'Too many resumes. Try again tomorrow.' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterS) } })
  const db = getScanDb()
  if (getPlan(db, r.user.id) !== 'pro') return NextResponse.json({ error: 'pro_only' }, { status: 402 })
  if (!hasKey(db, r.user.id)) return NextResponse.json({ error: 'no_api_key' }, { status: 400 })
  const { quotaStop } = queuePendingRows(db, r.user.id, batch)
  after(() => kickRunner(db))
  return NextResponse.json({ ...batchStatus(db, r.user.id, batch)!, quota_stop: quotaStop }, { status: 202 })
}
