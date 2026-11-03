import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { hasReadConsent, threadMessages } from '@/lib/outreach/replies'
import { inboxPage, markThreadRead, parseInboxQuery, InboxQueryError } from '@/lib/outreach/inbox'
import { gmailStatus } from '@/lib/gmail/oauth'
import { getSettings } from '@/lib/outreach/service'
import { sameOriginJson } from '@/lib/same-origin'
import { denied } from '@/lib/workspace-access'

// GET ?thread_id=<id>             one thread's messages (owner-scoped; another tenant's thread answers like an unknown one)
// GET ?job_id&status&class&thread&cursor&limit
//                                 one page of conversations, one row per thread, filtered and cut on the server
//                                 (lib/outreach/inbox.ts), with totals that do not depend on the page.
export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  const threadId = req.nextUrl.searchParams.get('thread_id')
  if (threadId) {
    // Owner-scoped: threadMessages returns empty for another tenant's thread.
    return NextResponse.json({ messages: threadMessages(db, user.tenantId, threadId) })
  }
  let page
  try { page = await inboxPage(db, user.tenantId, parseInboxQuery(req.nextUrl.searchParams)) } catch (e) {
    if (e instanceof InboxQueryError) return NextResponse.json({ error: e.code }, { status: 400 })
    throw e
  }

  const acc = db.prepare('SELECT read_granted FROM gmail_accounts WHERE tenant_id = ?').get(user.tenantId) as { read_granted: number } | undefined
  const gmail = gmailStatus(db, user.tenantId)
  return NextResponse.json({
    available: true,
    consent_accepted: hasReadConsent(db, user.tenantId),
    read_granted: acc?.read_granted === 1,
    account: gmail?.status === 'active' ? gmail.email : null,
    ...page,

    // The tenant's own booking link, shown back only to that tenant. Validated https-only
    // on save (cleanBookingUrl). Display is a handoff - it never proves availability or books.
    booking_url: getSettings(db, user.tenantId)?.booking_url ?? null,
  })
}

// POST {thread_id, action: 'read'}: the owner opened the thread. Only the caller's own thread can be marked; another
// tenant's thread answers 404 exactly like an unknown one.
export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  // Read state is the workspace's (one row per tenant and thread), so marking it is an operator's write.
  const no = denied(user, 'operate'); if (no) return no
  // Cookie-authenticated write: JSON only, and same-origin when the browser says where it came from (lib/same-origin.ts).
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const b = await req.json().catch(() => null) as { thread_id?: unknown; action?: unknown } | null
  if (!b || typeof b.thread_id !== 'string' || !b.thread_id || b.thread_id.length > 200 || b.action !== 'read') return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  const ok = await markThreadRead(getScanDb(), user.tenantId, b.thread_id)
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'not_found' }, { status: 404 })
}
