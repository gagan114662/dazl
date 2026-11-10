import { after, NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { readPlan } from '@/lib/plans'
import { getDb } from '@/lib/db/client'
import { hasKey } from '@/lib/llm/key-store'
import { kickRunner } from '@/lib/scan/runner'
import { BATCH_BUDGET_UNKNOWN, BATCH_BUDGET_UNKNOWN_MESSAGE, batchRunBudget, batchStatus, queuePendingRows } from '@/lib/scan/csv-import'
import { denied } from '@/lib/workspace-access'
import type { Action } from '@/lib/workspaces'

async function load(batch: string, action: Action) {
  const user = await requireUser()
  if (!user) return { res: NextResponse.json({ error: 'Not signed in' }, { status: 401 }) }
  const no = denied(user, action)
  if (no) return { res: no }
  if (!/^[a-f0-9]{24}$/.test(batch)) return { res: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  const status = batchStatus(getScanDb(), user.tenantId, batch)
  if (!status) return { res: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  return { user, status }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ batch: string }> }) {
  const { batch } = await params
  const r = await load(batch, 'read')
  if ('res' in r) return r.res
  return NextResponse.json(r.status)
}

// Resume: queue jobs for rows the last attempt left pending (quota reached mid-batch).
// Failed jobs are not re-run - re-import the file to try those domains again.
export async function POST(req: NextRequest, { params }: { params: Promise<{ batch: string }> }) {
  const { batch } = await params
  const r = await load(batch, 'operate')
  if ('res' in r) return r.res
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const rl = (await rateLimit(`csv-resume:${r.user.tenantId}`, 20, 24 * 60 * 60 * 1000))
  if (!rl.ok) return NextResponse.json({ error: 'Too many resumes. Try again tomorrow.' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterS) } })
  const db = getScanDb()
  if ((await readPlan(await getDb(), r.user.tenantId)) !== 'pro') return NextResponse.json({ error: 'pro_only' }, { status: 402 })
  if (!hasKey(db, r.user.tenantId)) return NextResponse.json({ error: 'no_api_key' }, { status: 400 })
  // #916: resumed rows run under the batch's own recorded budget. A batch without a usable recorded budget (imported
  // before #916, or a stored value that no longer validates) is refused: nothing is queued, the owner re-imports.
  const known = batchRunBudget(db, r.user.tenantId, batch)!
  if (!known.known) return NextResponse.json({ error: BATCH_BUDGET_UNKNOWN, message: BATCH_BUDGET_UNKNOWN_MESSAGE, reimport: true }, { status: 409 })
  const { quotaStop, budgetUnknown } = queuePendingRows(db, r.user.tenantId, batch)
  if (budgetUnknown) return NextResponse.json({ error: BATCH_BUDGET_UNKNOWN, message: BATCH_BUDGET_UNKNOWN_MESSAGE, reimport: true }, { status: 409 })
  const rb = batchRunBudget(db, r.user.tenantId, batch)!
  after(() => kickRunner(db))
  return NextResponse.json({ ...batchStatus(db, r.user.tenantId, batch)!, quota_stop: quotaStop, budget: rb.budget ? JSON.parse(rb.budget) as Record<string, boolean> : null, budget_recorded: rb.recorded }, { status: 202 })
}
