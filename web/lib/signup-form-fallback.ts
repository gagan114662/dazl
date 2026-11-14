// #1116: the sign-up form without its script. A native form post gets a redirect back to a page that says what happened;
// the outcome travels as a short CODE in the address, never a field value (no email, name or password in any URL, log or
// history entry). The page (app/sign-up/page.tsx) turns the code into the same words the scripted form shows.
import { NextResponse, type NextRequest } from 'next/server'

export type SignUpFormCode = 'sent' | 'signed_in' | 'email' | 'password' | 'exists' | 'rate' | 'unavailable' | 'failed'

// 303: the browser follows with a GET, so a reload never re-posts the form.
export function signUpFormRedirect(req: NextRequest, code: SignUpFormCode): NextResponse {
  const to = code === 'signed_in' ? '/app' : code === 'sent' ? '/sign-up?sent=1' : `/sign-up?error=${code}`
  // A RELATIVE Location: behind the proxy the server's own origin is an internal address, and the browser resolves a
  // relative one against the page it posted from.
  void req
  return new NextResponse(null, { status: 303, headers: { Location: to, 'Cache-Control': 'no-store' } })
}

// The words for each error code: the scripted form's own messages (app/api/auth/signup/route.ts). An unknown code says
// nothing rather than something untrue.
export const SIGN_UP_FORM_ERRORS: Record<string, string> = {
  email: 'Enter a valid email address',
  password: 'Use a password of 10 or more characters with letters and numbers.',
  exists: 'We could not create an account with those details. Try signing in instead.',
  rate: 'Too many attempts. Try again later.',
  unavailable: 'Sign-up is briefly unavailable. Try again in a moment.',
  failed: 'Something went wrong. Try again.',
}
export const signUpFormError = (code: unknown): string => (typeof code === 'string' && Object.hasOwn(SIGN_UP_FORM_ERRORS, code) ? SIGN_UP_FORM_ERRORS[code] : '')
