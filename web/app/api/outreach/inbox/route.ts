import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { hasReadConsent, inboxRows, threadMessages } from '@/lib/outreach/replies'
import { gmailStatus } from '@/lib/gmail/oauth'
import { getSettings } from '@/lib/outreach/service'

export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  const threadId = req.nextUrl.searchParams.get('thread_id')
  if (threadId) {
    // Owner-scoped: threadMessages returns empty for another tenant's thread.
    return NextResponse.json({ messages: threadMessages(db, user.tenantId, threadId) })
  }
  const acc = db.prepare('SELECT read_granted FROM gmail_accounts WHERE tenant_id = ?').get(user.tenantId) as { read_granted: number } | undefined
  const gmail = gmailStatus(db, user.tenantId)
  return NextResponse.json({
    available: true,
    consent_accepted: hasReadConsent(db, user.tenantId),
    read_granted: acc?.read_granted === 1,
    account: gmail?.status === 'active' ? gmail.email : null,
    rows: inboxRows(db, user.tenantId),
    // The tenant's own booking link, shown back only to that tenant. Validated https-only
    // on save (cleanBookingUrl). Display is a handoff - it never proves availability or books.
    booking_url: getSettings(db, user.tenantId)?.booking_url ?? null,
  })
}
