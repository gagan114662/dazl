import { after, NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { getPlan } from '@/lib/plans'
import { hasKey } from '@/lib/llm/key-store'
import { kickRunner } from '@/lib/scan/runner'
import { commenterBatchStatus, createCommenterBatch, MAX_PROFILES, parseProfiles, queuePendingCommenters } from '@/lib/scan/commenter-import'

const MAX_UPLOAD = 100_000 // 100 profiles is the cap; a bigger paste is a mistake, not a use case

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const rl = rateLimit(`commenter-import:${user.id}`, 10, 24 * 60 * 60 * 1000)
  if (!rl.ok) return NextResponse.json({ error: 'Too many imports. Try again tomorrow.' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterS) } })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  const text = typeof body?.csv === 'string' ? body.csv : ''
  if (!text.trim()) return NextResponse.json({ error: 'Paste LinkedIn profile URLs or upload a CSV of them, one per line' }, { status: 400 })
  if (text.length > MAX_UPLOAD) return NextResponse.json({ error: 'That file is too large' }, { status: 400 })

  const db = getScanDb()
  // Pro only, and never trial-funded: the tenant's own LLM key pays for every research job.
  if (getPlan(db, user.id) !== 'pro') return NextResponse.json({ error: 'pro_only' }, { status: 402 })
  if (!hasKey(db, user.id)) return NextResponse.json({ error: 'no_api_key' }, { status: 400 })

  const parsed = parseProfiles(text)
  if (parsed.valid.length === 0) return NextResponse.json({ error: 'No valid profile URLs found', invalid: parsed.invalid }, { status: 400 })
  const batchId = createCommenterBatch(db, user.id, parsed.valid)
  const { queued, quotaStop } = queuePendingCommenters(db, user.id, batchId)
  after(() => kickRunner(db))
  return NextResponse.json({
    batch_id: batchId,
    accepted: parsed.valid.length,
    queued,
    max_profiles: MAX_PROFILES,
    overflow: parsed.overflow,
    invalid: parsed.invalid,
    name_source: 'derived',
    quota_stop: quotaStop,
    ...(quotaStop ? { message: `${queued} of ${parsed.valid.length} ran, quota reached` } : {}),
  }, { status: 202 })
}

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  const rows = db.prepare('SELECT id FROM commenter_batches WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').all(user.id) as { id: string }[]
  if (rows.length === 0) return NextResponse.json({ batch: null })
  return NextResponse.json({ batch: commenterBatchStatus(db, user.id, rows[0].id) })
}
