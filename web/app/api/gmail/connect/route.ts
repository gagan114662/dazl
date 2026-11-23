import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { GmailError, startOAuth } from '@/lib/gmail/oauth'
import { denied, stale } from '@/lib/workspace-access'


export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.redirect(new URL('/sign-in', process.env.PUBLIC_BASE_URL || req.url))
  const no = denied(user, 'configure'); if (no) return no
  // a browser navigation, not a fetch: a stale session goes back to Settings, which asks to confirm it is them
  if (stale(user)) return NextResponse.redirect(new URL('/app/settings?reauth=1#gmail', process.env.PUBLIC_BASE_URL || req.url))

  try {
    // Send-only (#1603): the connect asks Google for permission to send and nothing else, and records no
    // reply-reading consent. Reconnecting an account that had the old read scope leaves it send-only.
    const db = getScanDb()
    return NextResponse.redirect(startOAuth(db, user.tenantId))
  } catch (e) {
    if (e instanceof GmailError && e.kind === 'config') return NextResponse.json({ error: 'Gmail is not set up on this server yet' }, { status: 503 })
    throw e
  }
}
