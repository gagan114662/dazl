import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { createReopenDraft, editReopen, listReopens, resolveReopen, sendReopen, skipReopen, warmAgain } from '@/lib/outreach/reopen'
import { OutreachError } from '@/lib/outreach/service'
import { denied } from '@/lib/workspace-access'
import { audit } from '@/lib/audit-route'

const STATUS: Record<string, number> = { not_found: 404, already_created: 409, paused: 409, not_sales_contact: 409, lead_currentness_unconfirmed: 409, lead_evidence_withdrawn: 409, domain_unconfirmed: 409, review_unreadable: 409, already_sent: 409, send_uncertain: 409, already_uncertain: 409, not_uncertain: 409, send_in_progress: 409, daily_cap: 409, final: 409, not_editable: 409, bad_body: 400, suppressed: 409, lead_missing: 404, root_missing: 404, gmail_not_connected: 400, gmail_reconnect_needed: 400, sender_changed: 409, authority_unreadable: 503 }

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  return NextResponse.json({ warm: warmAgain(db, user.tenantId), reopens: listReopens(db, user.tenantId) })
}

// Actions: {action:'draft', thread_id} | {action:'edit', thread_id, body} |
// {action:'skip', thread_id} | {action:'send', thread_id} |
// {action:'mark_sent'|'retry', thread_id} (resolve a send whose outcome is unknown; the user checked Gmail Sent)
// 'send' is the approval: the UI shows the exact body next to the button.
export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'operate'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const rl = (await rateLimit(`reopen:${user.tenantId}`, 20, 60 * 60 * 1000))
  if (!rl.ok) return NextResponse.json({ error: 'Too many actions. Try again later.' }, { status: 429 })
  const body = await req.json().catch(() => null)
  const threadId = typeof body?.thread_id === 'string' ? body.thread_id : ''
  const action = typeof body?.action === 'string' ? body.action : ''
  const db = getScanDb()
  // The re-open's state before and after a send: a send records only when it claimed the draft, with the outcome the
  // row shows (sent, or still claimed = uncertain), whether the call returned or threw. Never the recipient or body.
  const state = () => (db.prepare('SELECT status FROM reopen_messages WHERE tenant_id = ? AND thread_id = ?').get(user.tenantId, threadId) as { status: string } | undefined)?.status
  const sendAudit = async (before: string | undefined) => {
    const after = state()
    if (before === 'draft' && (after === 'sent' || after === 'approved')) await audit(user, req, { action: 'reopen.send', resource: 'thread', id: threadId, summary: { outcome: after === 'sent' ? 'sent' : 'uncertain' } })
  }
  try {
    if (action === 'draft') createReopenDraft(db, user.tenantId, threadId, user.business_name)
    else if (action === 'edit') editReopen(db, user.tenantId, threadId, typeof body?.body === 'string' ? body.body : '')
    else if (action === 'skip') skipReopen(db, user.tenantId, threadId)
    else if (action === 'mark_sent' || action === 'retry') resolveReopen(db, user.tenantId, threadId, action === 'mark_sent' ? 'sent' : 'retry')
    else if (action === 'send') {
      // The button sends what was on screen: apply the editor's body first when one came along.
      if (typeof body?.body === 'string') {
        try { editReopen(db, user.tenantId, threadId, body.body) } catch (e) { if (!(e instanceof OutreachError) || (e as OutreachError).code !== 'not_editable') throw e }
      }
      const before = state()
      const claimedBy = { won: false }
      try { await sendReopen(db, user.tenantId, threadId, { claimedBy }) } finally { if (claimedBy.won) await sendAudit(before) }
    }
    else return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  } catch (e) {
    if (e instanceof OutreachError) return NextResponse.json({ error: e.code }, { status: STATUS[e.code] ?? 500 })
    throw e
  }
  // skip, mark sent and retry throw when they change nothing, so reaching here means they changed the re-open
  if (action === 'skip' || action === 'mark_sent' || action === 'retry') await audit(user, req, { action: `reopen.${action}`, resource: 'thread', id: threadId })
  return NextResponse.json({ warm: warmAgain(db, user.tenantId), reopens: listReopens(db, user.tenantId) })
}
