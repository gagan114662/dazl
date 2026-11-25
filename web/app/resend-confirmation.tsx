'use client'
import { useState, type FormEvent } from 'react'

// #1647: the resend block for a user staring at "Confirm your email first". It is placed beside that message (sign-in,
// Factory's lane) and on /verify where no link was found. The server answers the same for every well-formed address,
// unknown ones included, so every line here stays conditional: none of them says whether an account exists.
export type ResendState = 'idle' | 'sending' | 'sent' | 'limited' | 'unavailable' | 'bad' | 'uncertain'

// One outcome per server answer; a network failure cannot tell the user anything either way.
export function resendResult(status?: number): ResendState {
  if (status !== undefined && status >= 200 && status < 300) return 'sent'
  if (status === 429) return 'limited'
  if (status === 503) return 'unavailable'
  if (status === 400) return 'bad'
  return 'uncertain'
}

export const resendCopy: Record<Exclude<ResendState, 'idle' | 'sending'>, string> = {
  sent: 'Request received. If an unconfirmed dazl account uses this address, a fresh confirmation link is on its way; it usually arrives within a minute. Check spam too.',
  limited: 'Too many resend requests. Wait a moment before trying again.',
  unavailable: 'Email delivery is not available right now. Try again later.',
  bad: 'Enter the email address you signed up with.',
  uncertain: 'We could not send that request. Try again in a moment.',
}

export function ResendConfirmation({ email: preset = '' }: { email?: string }) {
  const [address, setAddress] = useState(preset)
  const [state, setState] = useState<ResendState>('idle')
  async function resend(e: FormEvent) {
    e.preventDefault()
    if (state === 'sending') return
    setState('sending')
    let status: number | undefined
    try {
      const r = await fetch('/api/auth/email/send-verification', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: address.trim().toLowerCase() }) })
      status = r.status
    } catch { /* the server could not be reached; the answer stays uncertain */ }
    setState(resendResult(status))
  }
  return (
    <form onSubmit={resend} className="mt-3 flex flex-col gap-2 text-sm">
      <label className="flex flex-col gap-1 text-sm text-[#333]" htmlFor="resend-email">Email
        <input id="resend-email" name="email" type="email" autoComplete="email" required className="field" value={address}
          onChange={e => setAddress(e.target.value)} placeholder="you@company.com" />
      </label>
      <button type="submit" disabled={state === 'sending'} className="btn-primary !py-2 text-sm">
        {state === 'sending' ? 'Sending…' : 'Resend confirmation email'}
      </button>
      {(state !== 'idle' && state !== 'sending') && <p role="status" className="text-[#555] text-sm">{resendCopy[state]}</p>}
    </form>
  )
}
