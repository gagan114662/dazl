// An invitation link (/app/join#t=...) opened while signed out is redirected to /sign-in, and the browser keeps the
// #fragment across that redirect. The sign-in and sign-up pages keep the token here (this tab only, never sent to a
// server) and return to /app/join with it once the account is signed in, instead of to /app, where it would be lost.
const KEY = 'dazl_invite'
const TOKEN = /^[a-f0-9]{64}$/

export function keepInvite(): void {
  const t = new URLSearchParams(window.location.hash.slice(1)).get('t')
  if (!t || !TOKEN.test(t)) return
  try { sessionStorage.setItem(KEY, t) } catch { /* storage blocked: the invitee opens the link again */ }
  history.replaceState(null, '', window.location.pathname + window.location.search)
}

export function afterSignIn(): string {
  let t: string | null = null
  try { t = sessionStorage.getItem(KEY); sessionStorage.removeItem(KEY) } catch { /* storage blocked */ }
  return t && TOKEN.test(t) ? `/app/join#t=${t}` : '/app'
}
