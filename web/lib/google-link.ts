// Linking Google sign-in to the signed-in account and coming back to the page that asked (#1095). Pure and
// client-safe: the start route stores the return page, the callback reads it back, and both screens use the copy.

// The page to come back to after linking: only a dazl app page (/app or below), a plain path with an optional simple
// query. Anything else (another site, a protocol, "//", backslashes, "..", control characters, a fragment, an
// over-long value) is refused, so the return page can never become an open redirect.
const NEXT = /^\/app(\/[A-Za-z0-9_\-/]*)?(\?[A-Za-z0-9_\-=&.%]*)?$/
export function safeNext(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 200 || !NEXT.test(v)) return null
  if (v.includes('//') || v.includes('..') || /%2f|%5c|%2e/i.test(v)) return null
  return v
}

export function linkGoogleHref(next: string): string {
  const safe = safeNext(next)
  return safe ? `/api/auth/google?link=1&next=${encodeURIComponent(safe)}` : '/api/auth/google?link=1'
}

// What lib/auth-google.ts linkGoogle (and the callback) can answer.
export const GOOGLE_LINK_RESULTS = ['linked', 'already', 'taken', 'mismatch', 'unverified', 'signed_out', 'reauth_required'] as const
export type GoogleLinkResult = typeof GOOGLE_LINK_RESULTS[number]

const COPY: Record<GoogleLinkResult, { ok: boolean; text: string }> = {
  linked: { ok: true, text: 'Google sign-in is added to this account.' },
  already: { ok: true, text: 'Google sign-in was already added.' },
  taken: { ok: false, text: 'That Google account already signs in to another dazl account.' },
  mismatch: { ok: false, text: 'That Google account uses a different email. Use the Google account with this email.' },
  unverified: { ok: false, text: 'Confirm your email first, then add Google sign-in.' },
  reauth_required: { ok: false, text: 'Confirm it is you first (sign in again), then add Google sign-in.' },
  signed_out: { ok: false, text: 'Sign in first, then add Google sign-in.' },
}
export function googleLinkResultCopy(r: unknown): { ok: boolean; text: string } {
  return typeof r === 'string' && r in COPY ? COPY[r as GoogleLinkResult] : { ok: false, text: 'Google sign-in could not be added. Try again.' }
}
