import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { GmailError, startOAuth } from '@/lib/gmail/oauth'
import { hasReadConsent } from '@/lib/outreach/replies'

export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.redirect(new URL('/sign-in', req.url))
  try {
    const withRead = req.nextUrl.searchParams.get('read') === '1'
    if (withRead && !hasReadConsent(getScanDb(), user.id)) return NextResponse.json({ error: 'Accept the reply-reading notice first' }, { status: 403 })
    return NextResponse.redirect(startOAuth(getScanDb(), user.id, { withRead }))
  } catch (e) {
    if (e instanceof GmailError && e.kind === 'config') return NextResponse.json({ error: 'Gmail is not set up on this server yet' }, { status: 503 })
    throw e
  }
}
