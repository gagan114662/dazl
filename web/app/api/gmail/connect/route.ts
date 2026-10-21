import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { GmailError, startOAuth } from '@/lib/gmail/oauth'

export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.redirect(new URL('/sign-in', req.url))
  try {
    return NextResponse.redirect(startOAuth(getScanDb(), user.id))
  } catch (e) {
    if (e instanceof GmailError && e.kind === 'config') return NextResponse.json({ error: 'Gmail is not set up on this server yet' }, { status: 503 })
    throw e
  }
}
