import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { approve, editDraft, OutreachError, resolveUncertain, sendMessage, skip } from '@/lib/outreach/service'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { denied } from '@/lib/workspace-access'
import type { Action } from '@/lib/workspaces'

const STATUS: Record<string, number> = { not_sales_contact: 422, lead_currentness_unconfirmed: 409, lead_ungraded: 409, lead_evidence_withdrawn: 409, domain_unconfirmed: 409, review_unreadable: 409, not_found: 404, already_sending: 409, already_uncertain: 409, not_approved: 409, not_a_draft: 409, not_editable: 409, not_skippable: 409, not_uncertain: 409, suppressed: 409, recipient_contacted_recently: 409, account_contacted_recently: 409, identity_review_required: 409, existing_customer: 409, open_deal: 409, identity_unresolved: 503, daily_cap: 429, gmail_rate_limited: 429 }

async function guard(req: NextRequest, id: string, action: Action) {
  const user = await requireUser()
  if (!user) return { res: NextResponse.json({ error: 'Not signed in' }, { status: 401 }) }
  const no = denied(user, action)
  if (no) return { res: no }
  if (!sameOriginJson(req)) return { res: NextResponse.json({ error: 'Bad request' }, { status: 400 }) }
  if (!/^[a-f0-9]{24}$/.test(id)) return { res: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  return { user }
}
const fail = (e: unknown) => {
  if (e instanceof OutreachError) return NextResponse.json({ error: e.code }, { status: STATUS[e.code] ?? 400 })
  throw e
}

// Edit subject and body. Any edit removes the approval.
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const g = await guard(req, id, 'operate')
  if (!g.user) return g.res
  const body = await req.json().catch(() => null)
  if (typeof body?.subject !== 'string' || typeof body?.body !== 'string') return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  try {
    editDraft(getScanDb(), g.user.tenantId, id, { subject: body.subject, body: body.body })
    return NextResponse.json({ ok: true })
  } catch (e) { return fail(e) }
}

// Actions: approve, skip, send, mark_sent, retry. One message per call, always a person's click.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const g = await guard(req, id, 'operate')
  if (!g.user) return g.res
  const body = await req.json().catch(() => null)
  const action = body?.action
  const db = getScanDb()
  try {
    if (action === 'approve') approve(db, g.user.tenantId, id)
    else if (action === 'skip') skip(db, g.user.tenantId, id)
    else if (action === 'mark_sent') resolveUncertain(db, g.user.tenantId, id, 'sent')
    else if (action === 'retry') resolveUncertain(db, g.user.tenantId, id, 'retry')
    else if (action === 'send') {
      const no = denied(g.user, 'send'); if (no) return no
      if (!(await rateLimit(`send:${g.user.tenantId}`, 60, 60 * 60 * 1000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
      // The identity and account checks run inside sendMessage, for every entry (lib/outreach/service.ts).
      return NextResponse.json({ result: await sendMessage(db, g.user.tenantId, id) })
    } else return NextResponse.json({ error: 'Bad request' }, { status: 400 })
    return NextResponse.json({ ok: true })
  } catch (e) { return fail(e) }
}
