import { after, NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { readPlan } from '@/lib/plans'
import { getDb } from '@/lib/db/client'
import { hasKey } from '@/lib/llm/key-store'
import { kickRunner } from '@/lib/scan/runner'
import { batchStatus, createBatch, MAX_DOMAINS, normalizeRunBudget, parseDomains, queuePendingRows } from '@/lib/scan/csv-import'
import { denied } from '@/lib/workspace-access'

const MAX_UPLOAD = 100_000 // ~50 domains is the cap; a bigger paste is a mistake, not a use case

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = await denied(user, 'operate'); if (no) return no
  const rl = (await rateLimit(`csv-import:${user.tenantId}`, 10, 24 * 60 * 60 * 1000))
  if (!rl.ok) return NextResponse.json({ error: 'Too many imports. Try again tomorrow.' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterS) } })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  const text = typeof body?.csv === 'string' ? body.csv : ''
  if (!text.trim()) return NextResponse.json({ error: 'Upload a CSV with one company domain per line' }, { status: 400 })
  if (text.length > MAX_UPLOAD) return NextResponse.json({ error: 'That file is too large' }, { status: 400 })

  const db = getScanDb()
  // Pro only, and never trial-funded: the tenant's own LLM key pays for every scan.
  if ((await readPlan(await getDb(), user.tenantId)) !== 'pro') return NextResponse.json({ error: 'pro_only' }, { status: 402 })
  if (!hasKey(db, user.tenantId)) return NextResponse.json({ error: 'no_api_key' }, { status: 400 })

  const parsed = parseDomains(text)
  if (parsed.valid.length === 0) return NextResponse.json({ error: 'No valid domains found', invalid: parsed.invalid }, { status: 400 })
  // Optional per-run budget controls for an explicitly bounded run. An explicitly
  // supplied budget that is not strictly valid narrowing controls - including an
  // explicit null - is rejected, never silently widened into an unrestricted run.
  const budgetSupplied = body !== null && typeof body === 'object' && 'budget' in body
  const nb = normalizeRunBudget(budgetSupplied ? body.budget : undefined, budgetSupplied)
  if (!nb.ok) return NextResponse.json({ error: nb.error }, { status: 400 })
  const batchId = createBatch(db, user.tenantId, parsed.valid)
  const { queued, quotaStop } = queuePendingRows(db, user.tenantId, batchId, nb.value)
  after(() => kickRunner(db))
  return NextResponse.json({
    batch_id: batchId,
    // Post-commit confirmation of the actual saved per-run control: the batch is
    // already created and the runner already kicked, so this echo is confirmation
    // of what was persisted, NOT a review/approval gate before execution.
    budget: nb.value ? JSON.parse(nb.value) as Record<string, boolean> : null,
    accepted: parsed.valid.length,
    queued,
    max_domains: MAX_DOMAINS,
    overflow: parsed.overflow,
    invalid: parsed.invalid,
    quota_stop: quotaStop,
    ...(quotaStop ? { message: `${queued} of ${parsed.valid.length} ran, quota reached` } : {}),
  }, { status: 202 })
}
