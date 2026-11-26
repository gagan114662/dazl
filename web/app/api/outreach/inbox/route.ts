import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb, type Db } from '@/lib/db/client'
import { hasReadConsentDb } from '@/lib/outreach/reply-reading'
import { inboxPage, markThreadRead, parseInboxQuery, InboxQueryError, threadMessages } from '@/lib/outreach/inbox'
import { readGmailStatus } from '@/lib/gmail/oauth'
import { sameOriginJson } from '@/lib/same-origin'
import { denied } from '@/lib/workspace-access'

async function ownsInboxThread(db: Db, tenantId: string, threadId: string): Promise<boolean> {
  return !!(await db.get('SELECT 1 FROM inbound_messages WHERE tenant_id = ? AND thread_id = ? UNION ALL SELECT 1 FROM followup_threads WHERE tenant_id = ? AND thread_id = ?',
    [tenantId, threadId, tenantId, threadId]))
}

// GET ?thread_id=<id>             one thread's messages (owner-scoped; another tenant's thread answers like an unknown one)
// GET ?job_id&status&class&thread&cursor&limit
//                                 one page of conversations, one row per thread, filtered and cut on the server
//                                 (lib/outreach/inbox.ts), with totals that do not depend on the page.
export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = await getDb()
  const threadId = req.nextUrl.searchParams.get('thread_id')
  if (threadId) {
    // Owner-scoped: threadMessages returns empty for another tenant's thread.
    const messages = await threadMessages(db, user.tenantId, threadId)
    // #830: a thread this workspace has no part of (another workspace's, or unknown) is not found, never an empty 200
    if (!messages.length && !(await ownsInboxThread(db, user.tenantId, threadId))) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    return NextResponse.json({ messages })
  }
  let page
  try {
    const query = parseInboxQuery(req.nextUrl.searchParams)
    const tenantId = user.tenantId
    if ((query.jobId && !(await db.get('SELECT 1 FROM scan_jobs WHERE id = ? AND user_id = ?', [query.jobId, tenantId])))
      || (query.threadId && !(await ownsInboxThread(db, tenantId, query.threadId)))) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    page = await inboxPage(db, tenantId, query)
  } catch (e) {
    if (e instanceof InboxQueryError) return NextResponse.json({ error: e.code }, { status: 400 })
    throw e
  }

  const [gmail, consent, settings] = await Promise.all([
    readGmailStatus(db, user.tenantId),
    hasReadConsentDb(db, user.tenantId),
    db.get<{ booking_url: string | null }>('SELECT booking_url FROM outreach_settings WHERE tenant_id = ?', [user.tenantId]),
  ])
  return NextResponse.json({
    available: true,
    consent_accepted: consent,
    read_granted: gmail?.read_granted ?? false,
    account: gmail?.status === 'active' ? gmail.email : null,
    ...page,

    // The tenant's own booking link, shown back only to that tenant. Validated https-only
    // on save (cleanBookingUrl). Display is a handoff - it never proves availability or books.
    booking_url: settings?.booking_url ?? null,
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
  const ok = await markThreadRead(await getDb(), user.tenantId, b.thread_id)
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'not_found' }, { status: 404 })
}
