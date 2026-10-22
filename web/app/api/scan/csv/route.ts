import { after, NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { getPlan } from '@/lib/plans'
import { hasKey } from '@/lib/llm/key-store'
import { kickRunner } from '@/lib/scan/runner'
import { batchStatus, createBatch, MAX_DOMAINS, parseDomains, queuePendingRows } from '@/lib/scan/csv-import'

const MAX_UPLOAD = 100_000 // ~50 domains is the cap; a bigger paste is a mistake, not a use case

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const rl = rateLimit(`csv-import:${user.id}`, 10, 24 * 60 * 60 * 1000)
  if (!rl.ok) return NextResponse.json({ error: 'Too many imports. Try again tomorrow.' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterS) } })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  const text = typeof body?.csv === 'string' ? body.csv : ''
  if (!text.trim()) return NextResponse.json({ error: 'Upload a CSV with one company domain per line' }, { status: 400 })
  if (text.length > MAX_UPLOAD) return NextResponse.json({ error: 'That file is too large' }, { status: 400 })

  const db = getScanDb()
  // Pro only, and never trial-funded: the tenant's own LLM key pays for every scan.
  if (getPlan(db, user.id) !== 'pro') return NextResponse.json({ error: 'pro_only' }, { status: 402 })
  if (!hasKey(db, user.id)) return NextResponse.json({ error: 'no_api_key' }, { status: 400 })

  const parsed = parseDomains(text)
  if (parsed.valid.length === 0) return NextResponse.json({ error: 'No valid domains found', invalid: parsed.invalid }, { status: 400 })
  const batchId = createBatch(db, user.id, parsed.valid)
  const { queued, quotaStop } = queuePendingRows(db, user.id, batchId)
  after(() => kickRunner(db))
  return NextResponse.json({
    batch_id: batchId,
    accepted: parsed.valid.length,
    queued,
    max_domains: MAX_DOMAINS,
    overflow: parsed.overflow,
    invalid: parsed.invalid,
    quota_stop: quotaStop,
    ...(quotaStop ? { message: `${queued} of ${parsed.valid.length} ran, quota reached` } : {}),
  }, { status: 202 })
}
