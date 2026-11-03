import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { denied } from '@/lib/workspace-access'
import { requestIdOf } from '@/lib/ops/request-log'
import { dealOwnerChoices, isStage, listDeals, routeQualifiedConversations } from '@/lib/pipeline/deals'

// Revenue pipeline (#366): this workspace's deals, and the members who may own one. The workspace comes only from the
// session; every read and write below is scoped to it.
export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const q = new URL(req.url).searchParams
  const stage = q.get('stage'), owner = q.get('owner')
  if ((stage !== null && !isStage(stage)) || (owner !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(owner))) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const db = await getDb()
  return NextResponse.json({ deals: await listDeals(db, user.tenantId, { stage, owner }), owners: await dealOwnerChoices(db, user.tenantId) }, { headers: { 'cache-control': 'no-store' } })
}

// { action: 'route' }: turn this workspace's new qualified conversations into deals now (the scheduled tick does the
// same). Does nothing until an admin has added a routing rule. Each created deal is audited in its own transaction.
export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'operate'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  if (body?.action !== 'route') return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const r = await routeQualifiedConversations(await getDb(), user.tenantId, { correlationId: requestIdOf(req) ?? null })
  return NextResponse.json({ ok: true, ...r })
}
