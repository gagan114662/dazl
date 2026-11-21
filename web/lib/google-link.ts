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

// #1319: the mailbox an address delivers to, for the link check only: lower-case, and a "+tag" in the local part set
// aside (name+x@domain and name@domain are one mailbox at every provider that supports plus-addressing). Nothing else is
// folded (no Gmail dot-removal, no domain aliases), so two different mailboxes never read as one.
export function mailboxKey(email: string): string {
  const e = String(email).trim().toLowerCase()
  const at = e.lastIndexOf('@')
  if (at <= 0) return e
  const local = e.slice(0, at), plus = local.indexOf('+')
  return `${plus > 0 ? local.slice(0, plus) : local}${e.slice(at)}`
}
export const sameMailbox = (a: string, b: string): boolean => !!a && !!b && mailboxKey(a) === mailboxKey(b)
// The Link Google box says up front which Google account to pick (#1319): the one for this account's mailbox.
export function googleAccountHint(email: unknown): string | null {
  if (typeof email !== 'string' || !email.includes('@')) return null
  return `Use the Google account for ${mailboxKey(email)}.`
}

// The page to come back to: the page as it is, or (#1319) when its query cannot travel (too long, or characters safeNext
// refuses, as a typed search can have) the same page without it. The search itself comes back from the pending search
// saved on click (app/app/trial-refusal-notice.tsx), so the person lands where they started, not on Settings.
export function linkGoogleHref(next: string): string {
  const safe = safeNext(next) ?? safeNext(typeof next === 'string' ? next.split('?')[0] : null)
  return safe ? `/api/auth/google?link=1&next=${encodeURIComponent(safe)}` : '/api/auth/google?link=1'
}

// #1319: the link result goes back to the page in this short-lived cookie, never in the address (no "?google=taken" in
// the URL bar, history or a shared link). Only GOOGLE_LINK_RESULTS values are written; the page reads it once and clears it.
export const GOOGLE_LINK_RESULT_COOKIE = 'dazl_google_link'
// What the page shows for a link it asked for, from the cookie (or an old ?google= address, kept readable), and the
// address's query without ?google=. Pure: the page passes location.search and document.cookie.
export function readGoogleLinkResult(at: { search: string; cookie: string }): { result: { ok: boolean; text: string } | null; search: string } {
  // only the google= pair is taken out; the rest of the address stays byte for byte (a typed search is not re-encoded)
  const pairs = at.search.replace(/^\?/, '').split('&').filter(Boolean)
  const fromUrl = new URLSearchParams(pairs.filter(p => p.split('=')[0] === 'google').join('&')).get('google')
  const rest = pairs.filter(p => p.split('=')[0] !== 'google')
  const search = rest.length ? `?${rest.join('&')}` : ''
  const fromCookie = at.cookie.split(';').map(p => p.trim()).find(p => p.startsWith(`${GOOGLE_LINK_RESULT_COOKIE}=`))?.slice(GOOGLE_LINK_RESULT_COOKIE.length + 1) ?? ''
  const r = fromCookie || fromUrl
  return { result: r ? googleLinkResultCopy(r) : null, search }
}

// What lib/auth-google.ts linkGoogle (and the callback) can answer. failed / google_unverified: the Google round trip
// itself failed or was cancelled (#1095: the callback returns to the page, never to sign-in). unverified is no longer
// returned (the link confirms the address) but stays readable for an old ?google= in a bookmark.
export const GOOGLE_LINK_RESULTS = ['linked', 'already', 'taken', 'mismatch', 'unverified', 'signed_out', 'reauth_required', 'failed', 'google_unverified'] as const
export type GoogleLinkResult = typeof GOOGLE_LINK_RESULTS[number]

const COPY: Record<GoogleLinkResult, { ok: boolean; text: string }> = {
  linked: { ok: true, text: 'Google sign-in is added to this account.' },
  already: { ok: true, text: 'Google sign-in was already added.' },
  taken: { ok: false, text: 'That Google account already signs in to another dazl account. Pick a different Google account, the one for this account\'s email.' },
  mismatch: { ok: false, text: 'That Google account uses a different email. Use the Google account with this account\'s email (a +tag in it is fine).' },
  unverified: { ok: false, text: 'Confirm your email first, then add Google sign-in.' },
  reauth_required: { ok: false, text: 'Confirm it is you first: enter your password, then link Google again.' },
  signed_out: { ok: false, text: 'Sign in first, then add Google sign-in.' },
  failed: { ok: false, text: 'Google sign-in was not added (cancelled or failed). Try Link Google again.' },
  google_unverified: { ok: false, text: 'Google has not verified that email address yet, so it could not be linked. Verify it with Google, then try again.' },
}
export function googleLinkResultCopy(r: unknown): { ok: boolean; text: string } {
  return typeof r === 'string' && r in COPY ? COPY[r as GoogleLinkResult] : { ok: false, text: 'Google sign-in could not be added. Try again.' }
}
