import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { normalizeIcp } from '@/lib/scan/icp'
import { createWatch, listWatches, watchAction } from '@/lib/watch'
import { normalizeScanBudget } from '@/lib/scan/run-budget'
import { denied } from '@/lib/workspace-access'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  return NextResponse.json({ watches: await listWatches(await getDb(), user.tenantId) })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'operate'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!(await rateLimit(`watch:${user.tenantId}`, 30, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const body = await req.json().catch(() => null)
  const db = await getDb()
  if (body?.action) {
    const id = typeof body.id === 'string' ? body.id : ''
    if (!['pause', 'resume', 'delete'].includes(body.action) || !/^[a-f0-9]{24}$/.test(id)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
    if (!(await watchAction(db, user.tenantId, id, body.action))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  }
  const query = typeof body?.query === 'string' ? body.query.trim() : ''
  const icp = normalizeIcp(body?.icp)
  if (query.length < 3 || query.length > 600 || !icp) return NextResponse.json({ error: 'A search and its profile are needed' }, { status: 400 })
  // Optional per-run budget, validated like POST /api/scan; each weekly run is bounded separately (not the watch in total).
  const budgetSupplied = body !== null && typeof body === 'object' && 'budget' in body
  const nb = normalizeScanBudget(budgetSupplied ? body.budget : undefined, budgetSupplied)
  if (!nb.ok) return NextResponse.json({ error: 'invalid_budget', detail: nb.error }, { status: 400 })
  // Optional: the finished own search this play continues from, linked as its first run.
  const jobId = typeof body?.job_id === 'string' ? body.job_id : undefined
  if (jobId !== undefined && !/^[a-f0-9]{24}$/.test(jobId)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const { watch, error } = await createWatch(db, user.tenantId, query, JSON.stringify(icp), nb.value, undefined, jobId)
  if (error) return NextResponse.json({ error }, { status: 400 })
  return NextResponse.json({ watch })
}
