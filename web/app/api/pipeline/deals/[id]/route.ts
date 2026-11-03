import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { denied } from '@/lib/workspace-access'
import { requestIdOf } from '@/lib/ops/request-log'
import { changeDeal, getDeal, parseChange } from '@/lib/pipeline/deals'

const ID = /^[a-f0-9]{24}$/
const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404 })

// One deal of this workspace with its full stage history. Another workspace's deal id answers 404, like a missing one.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const { id } = await params
  if (!ID.test(id)) return notFound()
  const d = await getDeal(await getDb(), user.tenantId, id)
  return d ? NextResponse.json(d, { headers: { 'cache-control': 'no-store' } }) : notFound()
}

// Move a deal's stage, set its owner, amount or close date, or close it won/lost with a reason. `version` must be the
// version the caller saw (409 otherwise). The change, its history snapshot and its audit event commit together.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'operate'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const { id } = await params
  if (!ID.test(id)) return notFound()
  const body = await req.json().catch(() => null)
  const change = parseChange(body)
  if (!change || !Number.isSafeInteger(body?.version) || body.version < 1) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const r = await changeDeal(await getDb(), user.tenantId, user.actorId, id, body.version, change, { correlationId: requestIdOf(req) ?? null })
  if (r.ok) return NextResponse.json({ ok: true, deal: r.deal })
  if (r.error === 'not_found') return notFound()
  return NextResponse.json({ error: r.error }, { status: r.error === 'conflict' ? 409 : 400 })
}
