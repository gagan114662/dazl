import { systemMailAvailable } from '@/lib/system-mail'
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { sendVerification } from '@/lib/email-ownership'

// Send (again) a verification link to the signed-in account's own email. Earlier links stop working.
export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!systemMailAvailable()) return NextResponse.json({ error: 'Email delivery is not available. Try again later.' }, { status: 503 })
  if (!(await rateLimit(`verify-send:${user.actorId}`, 3, 60 * 60 * 1000)).ok) return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429 })
  return NextResponse.json({ ok: true, sent: await sendVerification(await getDb(), user.actorId) })
}
