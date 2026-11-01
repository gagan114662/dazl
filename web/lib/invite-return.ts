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

export function afterSignIn(): string {
  let t: string | null = null
  try { t = sessionStorage.getItem(KEY); sessionStorage.removeItem(KEY) } catch { /* storage blocked */ }
  const invite = t && TOKEN.test(t) ? `/app/join#t=${t}` : null
  return claimIntent() !== null ? '/preview/claim' : invite ?? '/app'
}

// Keep a preview-claim token for the auth round trip (#416). Called only from the preview page itself.
export function keepClaim(t: string): void {
  if (!CLAIM_TOKEN.test(t)) return
  try { sessionStorage.setItem(CLAIM_KEY, t) } catch { /* storage blocked: the prospect opens the link again */ }
}

// The claim this tab is carrying, kept (not consumed) so a failed sign-in can be retried; the claim page clears it.
export function claimIntent(): string | null {
  let t: string | null = null
  try { t = sessionStorage.getItem(CLAIM_KEY) } catch { /* storage blocked */ }
  return t && CLAIM_TOKEN.test(t) ? t : null
}

export function clearClaim(): void {
  try { sessionStorage.removeItem(CLAIM_KEY) } catch { /* storage blocked */ }
}
