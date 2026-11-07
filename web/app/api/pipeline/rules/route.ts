import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { denied } from '@/lib/workspace-access'
import { requestIdOf } from '@/lib/ops/request-log'
import { addRule, deactivateRule, listRules, parseRule } from '@/lib/pipeline/deals'

// Routing rules of this workspace's revenue pipeline (#366), in the order they are tried.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  return NextResponse.json({ rules: await listRules(await getDb(), user.tenantId) }, { headers: { 'cache-control': 'no-store' } })
}

// { action: 'add', match_kind, match_value, owner_id, sla_hours } appends a rule; { action: 'deactivate', id } turns one
// off (rules are never deleted, so every routed deal's rule_id stays explainable). Admins only ('configure'): adding the
// first rule is what turns routing on for the workspace.
export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'configure'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  const db = await getDb(), correlationId = requestIdOf(req) ?? null
  if (body?.action === 'add') {
    const input = parseRule(body)
    if (!input) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
    const r = await addRule(db, user.tenantId, user.actorId, input, { correlationId })
    return r.ok ? NextResponse.json({ ok: true, rule: r.rule }, { status: 201 }) : NextResponse.json({ error: r.error }, { status: 400 })
  }
  if (body?.action === 'deactivate') {
    if (typeof body.id !== 'string' || !/^[a-f0-9]{24}$/.test(body.id)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
    return (await deactivateRule(db, user.tenantId, user.actorId, body.id, { correlationId })) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return NextResponse.json({ error: 'Bad request' }, { status: 400 })
}
