import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { can } from '@/lib/workspaces'
import { assignDeal, createDeal, DealError, dealHistory, isStage, listDeals, moveDeal, reopenDeal, revenueReport } from '@/lib/pipeline/deals'

// Deals of the workspace (lib/pipeline/deals.ts, #366): the pipeline and its revenue report, and the audited actions on
// a deal. Everything is scoped to the session's workspace (tenantId); changing a deal needs the operate role.
const MSG: Record<string, [number, string]> = {
  not_found: [404, 'Not found'],
  not_qualified: [409, 'A deal starts from a qualified conversation: an interested reply from this person, or a booked call.'],
  owner_not_member: [400, 'The owner must be a member of this workspace.'],
  deal_exists: [409, 'This lead already has an open deal.'],
  stale: [409, 'Someone changed this deal since you loaded it. Reload and try again.'],
  closed: [409, 'This deal is closed. Reopen it first.'],
  not_closed: [409, 'Only a closed deal can be reopened.'],
  bad_stage: [400, 'Pick another stage.'],
  bad_amount: [400, 'The amount must be a whole number of the smallest currency unit (for example cents).'],
  bad_currency: [400, 'Use a three-letter currency code, like USD.'],
  bad_close_date: [400, 'Use a YYYY-MM-DD close date.'],
  won_needs_amount: [400, 'A won deal needs its amount and currency.'],
  lost_needs_reason: [400, 'Say why the deal was lost.'],
  reopen_needs_reason: [400, 'Say why the deal is reopened.'],
}

export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!can(user.role, 'read')) return NextResponse.json({ error: 'Not allowed' }, { status: 403 })
  const db = await getDb()
  const id = req.nextUrl.searchParams.get('id')
  if (id) {
    const history = await dealHistory(db, user.tenantId, id)
    return history.length ? NextResponse.json({ history }) : NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return NextResponse.json({ deals: await listDeals(db, user.tenantId), report: await revenueReport(db, user.tenantId) })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!can(user.role, 'operate')) return NextResponse.json({ error: 'Not allowed' }, { status: 403 })
  if (!(await rateLimit(`deals:${user.tenantId}`, 120, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const b = await req.json().catch(() => null) as Record<string, unknown> | null
  const db = await getDb()
  const str = (v: unknown) => typeof v === 'string' ? v : ''
  const version = typeof b?.version === 'number' ? b.version : -1
  try {
    switch (b?.action) {
      case 'create':
        return NextResponse.json({ deal: await createDeal(db, user.tenantId, { leadId: str(b.lead_id), ownerId: str(b.owner_id) || user.actorId, actor: user.actorId }) }, { status: 201 })
      case 'move': {
        if (!isStage(b.to)) return NextResponse.json({ error: MSG.bad_stage[1] }, { status: 400 })
        const amount = b.amount_minor === undefined || b.amount_minor === null ? undefined : typeof b.amount_minor === 'number' ? b.amount_minor : NaN
        return NextResponse.json({ deal: await moveDeal(db, user.tenantId, str(b.id), { to: b.to, actor: user.actorId, version, amountMinor: amount,
          currency: typeof b.currency === 'string' ? b.currency : undefined, closeDate: typeof b.close_date === 'string' ? b.close_date : undefined, reason: typeof b.reason === 'string' ? b.reason : undefined }) })
      }
      case 'assign':
        return NextResponse.json({ deal: await assignDeal(db, user.tenantId, str(b.id), { ownerId: str(b.owner_id), actor: user.actorId, version }) })
      case 'reopen':
        return NextResponse.json({ deal: await reopenDeal(db, user.tenantId, str(b.id), { actor: user.actorId, version, reason: str(b.reason) }) })
      default:
        return NextResponse.json({ error: 'Bad request' }, { status: 400 })
    }
  } catch (e) {
    if (e instanceof DealError) { const [s, m] = MSG[e.code] ?? [400, 'Could not change the deal']; return NextResponse.json({ error: m, code: e.code }, { status: s }) }
    throw e
  }
}
