import { NextRequest, NextResponse } from 'next/server'
import { createHash, randomBytes, scryptSync } from 'crypto'
import { cookies } from 'next/headers'
import { createPasswordUser, createSession, SESSION_TTL_S } from '@/lib/auth-db'
import { sendSignupNotice, sendVerification } from '@/lib/email-ownership'
import { getDb } from '@/lib/db/client'
import { queuePendingLifecycleDb } from '@/lib/outreach/lifecycle'
import { cleanText, validateEmail, validatePassword } from '@/lib/validate'
import { clientIp, rateLimit, UNAVAILABLE_RETRY_S } from '@/lib/rate-limit'
import { captureError } from '@/lib/ops/errors'
import { systemMailAvailable } from '@/lib/system-mail'
import { requestIdOf } from '@/lib/ops/request-log'
import { deviceLabel } from '@/lib/sessions'
import { PREVIEW_CLAIM_COOKIE } from '@/lib/auth-google-response'
import { isClaimToken } from '@/lib/scan/preview-claim'

// #357, only while dazl can deliver mail (systemMailAvailable): one answer for every accepted sign-up, whether or not
// the address already has an account. Nobody is signed in here: the new account is marked email_confirmation_required
// and reaches the app only after its owner opens the confirmation link and signs in. An address that already has an
// account gets an email saying someone tried to sign up with it, instead of a different response.
// Without mail delivery, sign-up is exactly main's: the account is made with no confirmation requirement and signed in,
// and a taken address gets main's 400. That keeps the enumeration gap open until a mail sender is configured (#357 stays
// Refs); it never locks out an account that could not be sent a link.
const SIGNUP_ACCEPTED = { ok: true, check_email: true, message: 'Check your email. If this address can receive mail from us, a link to finish creating your account is on its way; open it, then sign in.' }
const accepted = () => NextResponse.json(SIGNUP_ACCEPTED)

export async function POST(req: NextRequest) {
  const rl = (await rateLimit(`signup:${clientIp(req)}`, 5, 60 * 60 * 1000))
  if (rl.unavailable) return NextResponse.json({ error: 'Sign-up is briefly unavailable. Try again in a moment.', code: 'limits_unavailable' }, { status: 503, headers: { 'Retry-After': String(UNAVAILABLE_RETRY_S) } })
  if (!rl.ok) {
    return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterS) } })
  }
  // Read once per request: the account is either made under the requirement with a link sent, or as on main.
  const mail = systemMailAvailable()
  try {
    const body = await req.json().catch(() => null)
    const email = validateEmail(body?.email)
    if (!email) return NextResponse.json({ error: 'Enter a valid email address' }, { status: 400 })
    const pwError = validatePassword(body?.password)
    if (pwError) return NextResponse.json({ error: pwError }, { status: 400 })
    if (mail) {
      // Mail to one address is capped, keyed by the address and not by whether it has an account: past the cap every
      // address gets the same answer and nothing is created or sent, so the cap cannot tell accounts apart either.
      const perAddress = await rateLimit(`signup-email:${createHash('sha256').update(email).digest('hex').slice(0, 32)}`, 3, 60 * 60 * 1000)
      if (perAddress.unavailable) return NextResponse.json({ error: 'Sign-up is briefly unavailable. Try again in a moment.', code: 'limits_unavailable' }, { status: 503, headers: { 'Retry-After': String(UNAVAILABLE_RETRY_S) } })
      if (!perAddress.ok) return accepted()
    }

    const salt = randomBytes(16).toString('hex')
    const hash = scryptSync(body.password, salt, 64).toString('hex')
    const id = randomBytes(16).toString('hex')

    const made = await createPasswordUser({ id, email, name: cleanText(body.name, 100), business_name: cleanText(body.business_name, 150), password_hash: hash, salt, requireConfirmation: mail })
    if (made === 'exists') {
      if (!mail) {
        // Same response shape as other failures: do not reveal which emails exist.
        return NextResponse.json({ error: 'We could not create an account with those details. Try signing in instead.' }, { status: 400 })
      }
      // The existing account is untouched; its owner hears that someone tried. A failed send changes nothing for the caller.
      await sendSignupNotice(await getDb(), email).catch(e => captureError(e, { source: 'route', where: '/api/auth/signup:notice', method: 'POST', requestId: requestIdOf(req) }))
      return accepted()
    }

    // #417: queue the conversion as PENDING: this typed address is unverified, so it cancels nothing and
    // excludes nothing until its owner proves it (verification link, reset link, or Google sign-in). The row
    // is durable, so a lost drain is completed by a later sign-in. Best-effort: never blocks the signup.
    try { await queuePendingLifecycleDb(await getDb(), 'signup', email, id) } catch (e) { captureError(e, { source: 'route', where: '/api/auth/signup:lifecycle', method: 'POST', requestId: requestIdOf(req) }) }
    // The address is unverified until its owner opens this link. A failed send is recorded and never blocks the signup;
    // with the requirement, signing in later sends a new link (app/api/auth/signin/route.ts).
    await sendVerification(await getDb(), id).catch(e => captureError(e, { source: 'route', where: '/api/auth/signup:verify', method: 'POST', requestId: requestIdOf(req) }))
    if (mail) return accepted()
    const token = await createSession(id, undefined, { device: deviceLabel(req.headers.get('user-agent')) })
    const cookieStore = await cookies()
    cookieStore.set('dazl_session', token, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: SESSION_TTL_S, path: '/' })
    // #416: a preview claim this browser is carrying from a Google attempt (the httpOnly intent cookie, which the page
    // cannot read) is resumed after a password sign-in too. Only an enum goes back; the claim route re-verifies the token.
    const resume = isClaimToken(req.cookies.get(PREVIEW_CLAIM_COOKIE)?.value) ? { resume: 'preview' as const } : {}
    return NextResponse.json({ ok: true, redirect: '/app', ...resume })
  } catch (e) {
    captureError(e, { source: 'route', where: '/api/auth/signup', method: 'POST', requestId: requestIdOf(req) })
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 })
  }
}
