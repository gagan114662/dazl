import { cookies } from 'next/headers'
import { systemMailAvailable } from '@/lib/system-mail'
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { validateEmail } from '@/lib/validate'
import { emailStatus, requestEmailChange } from '@/lib/email-ownership'
import { stale } from '@/lib/workspace-access'

// The signed-in account's email, whether it is verified, and whether it signs in with Google.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  return NextResponse.json(await emailStatus(await getDb(), user.actorId))
}

// Change the account's email: { email }. Needs a recent sign-in. A confirmation link goes to the new address and a
// notice to the current one; the email changes only when the link is opened. Same answer whether or not another
// account has the new address.
export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const old = stale(user); if (old) return old
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!systemMailAvailable()) return NextResponse.json({ error: 'Email delivery is not available. Try again later.' }, { status: 503 })
  if (!(await rateLimit(`email-change:${user.actorId}`, 5, 60 * 60 * 1000)).ok) return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429 })
  const body = await req.json().catch(() => null)
  const email = validateEmail(body?.email)
  if (!email) return NextResponse.json({ error: 'Enter a valid email address' }, { status: 400 })
  const sessionToken = (await cookies()).get('dazl_session')?.value
  if (!sessionToken) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  await requestEmailChange(await getDb(), user.actorId, email, Math.floor(Date.now() / 1000), sessionToken)
  return NextResponse.json({ ok: true, message: `If ${email} can be used, we sent it a confirmation link. Your email changes when you open it.` })
}
