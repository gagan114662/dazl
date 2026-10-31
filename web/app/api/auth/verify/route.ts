import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { verifyEmail } from '@/lib/email-ownership'

// Opens a verification link (the token from /verify#t=...). Public: the link may be opened in another browser. An
// unknown, used or expired link answers the same 410.
export async function POST(req: NextRequest) {
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!(await rateLimit(`verify:${clientIp(req)}`, 20, 60 * 60 * 1000)).ok) return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429 })
  const body = await req.json().catch(() => null)
  return await verifyEmail(await getDb(), body?.token) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'invalid_link' }, { status: 410 })
}
