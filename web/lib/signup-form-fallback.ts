// #1116: the sign-up form without its script. A native form post gets a redirect back to a page that says what happened;
// the outcome travels as a short CODE in the address, never a field value (no email, name or password in any URL, log or
// history entry). The page (app/sign-up/page.tsx) turns the code into the same words the scripted form shows.
import { NextResponse, type NextRequest } from 'next/server'

export type SignUpFormCode = 'sent' | 'signed_in' | 'signed_in_claim' | 'email' | 'password' | 'exists' | 'rate' | 'unavailable' | 'origin' | 'failed'

// 303: the browser follows with a GET, so a reload never re-posts the form.
export function signUpFormRedirect(req: NextRequest, code: SignUpFormCode): NextResponse {
  // signed_in_claim: this browser carries a preview claim (the JSON path's resume: 'preview'), so it goes on to claim it
  const to = code === 'signed_in' ? '/app' : code === 'signed_in_claim' ? '/preview/claim' : code === 'sent' ? '/sign-up?sent=1' : `/sign-up?error=${code}`
  // A RELATIVE Location: behind the proxy the server's own origin is an internal address, and the browser resolves a
  // relative one against the page it posted from.
  void req
  return new NextResponse(null, { status: 303, headers: { Location: to, 'Cache-Control': 'no-store' } })
}

// The words for each error code: the scripted form's messages (app/api/auth/signup/route.ts), with one line covering every
// password rule. An unknown code says
// nothing rather than something untrue.
export const SIGN_UP_FORM_ERRORS: Record<string, string> = {
  email: 'Enter a valid email address',
  password: 'Use a password of 10 to 200 characters with letters and numbers.',
  exists: 'We could not create an account with those details. Try signing in instead.',
  rate: 'Too many attempts. Try again later.',
  unavailable: 'Sign-up is briefly unavailable. Try again in a moment.',
  origin: 'We could not verify that this form was sent from dazl. Reload the page and try again.',
  failed: 'Something went wrong. Try again.',
}
export const signUpFormError = (code: unknown): string => (typeof code === 'string' && Object.hasOwn(SIGN_UP_FORM_ERRORS, code) ? SIGN_UP_FORM_ERRORS[code] : '')
