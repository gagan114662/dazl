// #719 F1: every 403 reauth_required must bring the "Confirm it is you" request back into view, even when the method
// (password/google) is the same as last time. Each event gets a new sequence number; ReauthGate scrolls on every one.
export type ReauthMethod = 'password' | 'google'
type Fetch = (...args: Parameters<typeof fetch>) => Promise<Response>

export function watchReauth(original: Fetch, onAsk: (method: ReauthMethod, seq: number) => void) {
  let seq = 0
  const ask = () => original('/api/auth/reauth').then(x => x.ok ? x.json() : null).catch(() => null)
    .then(info => { seq += 1; onAsk(info?.method === 'google' ? 'google' : 'password', seq) })
  const wrapped: Fetch = async (...args) => {
    const r = await original(...args)
    if (r.status === 403) await r.clone().json().then(j => j?.error === 'reauth_required' ? ask() : undefined).catch(() => {})
    return r
  }
  return { fetch: wrapped, ask }
}
