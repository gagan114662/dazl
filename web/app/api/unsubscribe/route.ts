import { NextRequest, NextResponse } from 'next/server'
import { getScanDb } from '@/lib/scan/service'
import { unsubscribeByToken } from '@/lib/outreach/service'
import { clientIp, rateLimit } from '@/lib/rate-limit'

// Public, no login. Mail clients call POST (RFC 8058 one-click); people click the link (GET).
// Both act at once: an unsubscribe is never delayed or made conditional.
function handle(req: NextRequest, html: boolean) {
  if (!rateLimit(`unsub:${clientIp(req)}`, 30, 60 * 60 * 1000).ok) return new NextResponse('Too many requests', { status: 429 })
  const ok = unsubscribeByToken(getScanDb(), req.nextUrl.searchParams.get('t') ?? '')
  if (!html) return new NextResponse(ok ? 'Unsubscribed' : 'Invalid link', { status: ok ? 200 : 400 })
  const msg = ok ? 'You have been unsubscribed and will not get more emails from this sender through dazl.' : 'This unsubscribe link is not valid.'
  return new NextResponse(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Unsubscribe</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><p>${msg}</p>`, { status: ok ? 200 : 400, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}
export const GET = (req: NextRequest) => handle(req, true)
export const POST = (req: NextRequest) => handle(req, false)
