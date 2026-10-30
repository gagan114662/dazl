import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { approve, editDraft, OutreachError, resolveUncertain, sendMessage, skip } from '@/lib/outreach/service'
import { firstTouchHold, graphStore } from '@/lib/accounts/cooldown'
import { sqliteDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'

const STATUS: Record<string, number> = { not_sales_contact: 422, lead_currentness_unconfirmed: 409, lead_ungraded: 409, lead_evidence_withdrawn: 409, domain_unconfirmed: 409, review_unreadable: 409, not_found: 404, already_sending: 409, already_uncertain: 409, not_approved: 409, not_a_draft: 409, not_editable: 409, not_skippable: 409, not_uncertain: 409, suppressed: 409, recipient_contacted_recently: 409, account_contacted_recently: 409, identity_review_required: 409, identity_unresolved: 503, daily_cap: 429, gmail_rate_limited: 429 }

async function guard(req: NextRequest, id: string) {
  const user = await requireUser()
  if (!user) return { res: NextResponse.json({ error: 'Not signed in' }, { status: 401 }) }
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
  const g = await guard(req, id)
  if (!g.user) return g.res
  const body = await req.json().catch(() => null)
  if (typeof body?.subject !== 'string' || typeof body?.body !== 'string') return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  try {
    editDraft(getScanDb(), g.user.id, id, { subject: body.subject, body: body.body })
    return NextResponse.json({ ok: true })
  } catch (e) { return fail(e) }
}

// Actions: approve, skip, send, mark_sent, retry. One message per call, always a person's click.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const g = await guard(req, id)
  if (!g.user) return g.res
  const body = await req.json().catch(() => null)
  const action = body?.action
  const db = getScanDb()
  try {
    if (action === 'approve') approve(db, g.user.id, id)
    else if (action === 'skip') skip(db, g.user.id, id)
    else if (action === 'mark_sent') resolveUncertain(db, g.user.id, id, 'sent')
    else if (action === 'retry') resolveUncertain(db, g.user.id, id, 'retry')
    else if (action === 'send') {
      if (!(await rateLimit(`send:${g.user.id}`, 60, 60 * 60 * 1000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
      // The lead's identity and the account cooldown on the graph's store (Postgres when the app runs on it); an identity
      // held for review or not decidable holds the send. sendMessage repeats the account rule on SQLite.
      const lead = (db.prepare('SELECT lead_id FROM outreach_messages WHERE id = ? AND tenant_id = ?').get(id, g.user.id) as { lead_id: string } | undefined)?.lead_id
      const held = lead ? await firstTouchHold(await graphStore(db), sqliteDb(db), g.user.id, lead) : null
      if (held) throw new OutreachError(held)
      return NextResponse.json({ result: await sendMessage(db, g.user.id, id) })
    } else return NextResponse.json({ error: 'Bad request' }, { status: 400 })
    return NextResponse.json({ ok: true })
  } catch (e) { return fail(e) }
}
