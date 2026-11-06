// An invitation link (/app/join#t=...) opened while signed out is redirected to /sign-in, and the browser keeps the
// #fragment across that redirect. The sign-in and sign-up pages keep the token here (this tab only, never sent to a
// server) and return to /app/join with it once the account is signed in, instead of to /app, where it would be lost.
const KEY = 'dazl_invite'
const TOKEN = /^[a-f0-9]{64}$/
// A preview claim being continued through password auth (#416): same tab-only rules as the invite above.
const CLAIM_KEY = 'dazl_preview_claim'
const CLAIM_TOKEN = /^[a-f0-9]{32}\.[a-f0-9]{32}$/

export function keepInvite(): void {
  const t = new URLSearchParams(window.location.hash.slice(1)).get('t')
  if (!t || !TOKEN.test(t)) return
  try { sessionStorage.setItem(KEY, t) } catch { /* storage blocked: the invitee opens the link again */ }
  history.replaceState(null, '', window.location.pathname + window.location.search)
}

// `resume` is the sign-in/sign-up API's answer: 'preview' when the browser still carries a Google-path claim intent
// cookie (e.g. Google refused the address and the prospect fell back to a password). Only that one value is honoured;
// the destination is always chosen here, never taken from a response or a URL.
export function afterSignIn(resume?: unknown): string {
  let t: string | null = null
  try { t = sessionStorage.getItem(KEY); sessionStorage.removeItem(KEY) } catch { /* storage blocked */ }
  const invite = t && TOKEN.test(t) ? `/app/join#t=${t}` : null
  return claimIntent() !== null || resume === 'preview' ? '/preview/claim' : invite ?? '/app'
}

// Where "Continue with Google" on the sign-in/sign-up pages starts (#416): a tab carrying a preview claim goes through
// the validating preview start route, so choosing Google there does not drop the claim and land on the generic /app.
export function googleStartHref(): string {
  const c = claimIntent()
  return c ? `/api/preview/${c.token}/google` : '/api/auth/google'
}

// Keep a preview-claim token (and what it is for) for the auth round trip (#416). Called only from the preview page.
export function keepClaim(t: string, business: string): void {
  if (!CLAIM_TOKEN.test(t)) return
  try { sessionStorage.setItem(CLAIM_KEY, JSON.stringify({ t, b: business.slice(0, 150) })) } catch { /* storage blocked: the prospect opens the link again */ }
}

// The claim this tab is carrying, kept (not consumed) so a failed sign-in can be retried; the claim page clears it.
export function claimIntent(): { token: string; business: string } | null {
  let raw: string | null = null
  try { raw = sessionStorage.getItem(CLAIM_KEY) } catch { /* storage blocked */ }
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as { t?: unknown; b?: unknown }
    return typeof v.t === 'string' && CLAIM_TOKEN.test(v.t) ? { token: v.t, business: typeof v.b === 'string' ? v.b : '' } : null
  } catch { return null }
}

export function clearClaim(): void {
  try { sessionStorage.removeItem(CLAIM_KEY) } catch { /* storage blocked */ }
}
