import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { denied } from '@/lib/workspace-access'
import { rateLimit } from '@/lib/rate-limit'
import { audit } from '@/lib/audit-route'
import { enqueueRun, listRuns } from '@/lib/workers/runtime'

// Runtime workers (docs/design/runtime-workers.md) for the session's workspace. POST { name, input } queues one run of a
// worker an operator granted to this workspace; GET lists this workspace's recent runs. The workspace is always the
// session's: no parameter names another one, and nothing here registers, starts or grants a worker (operator-only,
// scripts/workers.mts). An unknown worker, one not running and one not granted all answer the same 404.
const STATUS = { forbidden: 403, unavailable: 404, bad_input: 400, backlog: 429 } as const

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  return NextResponse.json({ runs: await listRuns(await getDb(), user) })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'operate')
  if (no) return no
  if (!(await rateLimit(`workers:${user.tenantId}`, 60, 60 * 1000)).ok) return NextResponse.json({ error: 'rate_limited' }, { status: 429 })
  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ error: 'bad_input' }, { status: 400 }) }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'bad_input' }, { status: 400 })
  const { name, input } = body as { name?: unknown; input?: unknown }
  const r = await enqueueRun(await getDb(), user, name, input)
  if (!r.ok) return NextResponse.json(r.detail ? { error: r.error, detail: r.detail } : { error: r.error }, { status: STATUS[r.error] })
  await audit(user, req, { action: 'worker.enqueue', resource: 'worker_run', id: r.id, summary: { worker: String(name) } })
  return NextResponse.json({ id: r.id }, { status: 202 })
}
