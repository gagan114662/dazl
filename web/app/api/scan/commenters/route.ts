import { after, NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { readPlan } from '@/lib/plans'
import { getDb } from '@/lib/db/client'
import { crawlJob } from '@/lib/connectors/sitecrawl'
import { enrichJobSignals } from '@/lib/signals'
import { commenterBatchStatus, enrichCommenters, importCommenters, MAX_PROFILES, parseImport } from '@/lib/scan/commenter-import'

const MAX_UPLOAD = 100_000 // 100 rows is the cap; a bigger paste is a mistake, not a use case

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const rl = (await rateLimit(`commenter-import:${user.id}`, 10, 24 * 60 * 60 * 1000))
  if (!rl.ok) return NextResponse.json({ error: 'Too many imports. Try again tomorrow.' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterS) } })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  const text = typeof body?.csv === 'string' ? body.csv : ''
  const context = typeof body?.context === 'string' ? body.context.trim() : ''
  if (!text.trim()) return NextResponse.json({ error: 'Upload a CSV (name, title, company, profile URL) or paste profile URLs, one per line' }, { status: 400 })
  if (!context) return NextResponse.json({ error: 'Add the context line - what post or thread these people engaged with' }, { status: 400 })
  if (context.length > 500) return NextResponse.json({ error: 'Context line is too long (500 max)' }, { status: 400 })
  if (text.length > MAX_UPLOAD) return NextResponse.json({ error: 'That file is too large' }, { status: 400 })

  const db = getScanDb()
  if ((await readPlan(await getDb(), user.id)) !== 'pro') return NextResponse.json({ error: 'pro_only' }, { status: 402 })

  const parsed = parseImport(text)
  if (parsed.valid.length === 0) return NextResponse.json({ error: 'No valid profile URLs found', invalid: parsed.invalid }, { status: 400 })
  const { batchId, jobId, imported } = importCommenters(db, user.id, parsed.valid, context)
  // Company-level enrichment after the response: BYOK Apollo/PDL org + people (no emails),
  // contact-page crawl (evidence fetch skipped - profile URLs are never fetched), SEC/job-board signals.
  after(async () => {
    await enrichCommenters(db, user.id, batchId).catch(() => {})
    const leadRows = db.prepare("SELECT id, company, source_url FROM leads WHERE scan_job_id = ? AND company <> ''").all(jobId) as { id: string; company: string; source_url: string }[]
    if (leadRows.length > 0) await crawlJob(db, user.id, jobId, { leads: leadRows, skipEvidenceFetch: true }).catch(() => {})
    await enrichJobSignals(db, user.id, jobId, {}).catch(() => {})
  })
  return NextResponse.json({
    batch_id: batchId,
    accepted: imported,
    mode: parsed.mode,
    max_profiles: MAX_PROFILES,
    overflow: parsed.overflow,
    invalid: parsed.invalid,
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
