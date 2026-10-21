import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { GmailError, startOAuth } from '@/lib/gmail/oauth'
import { acceptReadConsent } from '@/lib/outreach/replies'

export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.redirect(new URL('/sign-in', process.env.PUBLIC_BASE_URL || req.url))
  try {
    // One step: the connect always asks for send + read together, so the user sees a single
    // Google consent screen and never a second prompt. The plain-language notice of what the
    // read covers (only replies in threads dazl started, plus delivery-failure notices) is
    // shown next to the Connect button; starting the connect records acceptance of it.
    // On Google's screen the user can still untick the read scope: they then get send-only.
    const db = getScanDb()
    acceptReadConsent(db, user.id)
    return NextResponse.redirect(startOAuth(db, user.id, { withRead: true }))
  } catch (e) {
    if (e instanceof GmailError && e.kind === 'config') return NextResponse.json({ error: 'Gmail is not set up on this server yet' }, { status: 503 })
    throw e
  }
}
