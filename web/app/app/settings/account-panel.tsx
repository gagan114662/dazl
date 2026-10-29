'use client'
import { useEffect, useState } from 'react'

type Status = { email: string; verified: boolean; google: boolean }
const fetchStatus = (): Promise<Status | null> => fetch('/api/auth/email').then(r => r.ok ? r.json() : null).catch(() => null)
const GOOGLE: Record<string, string> = {
  linked: 'Google sign-in is added to this account.', already: 'Google sign-in was already added.',
  taken: 'That Google account already signs in to another dazl account.',
  mismatch: 'That Google account uses a different email. Use the Google account with this email.',
  unverified: 'Confirm your email first, then add Google sign-in.', reauth_required: 'Confirm it is you first (sign in again), then add Google sign-in.',
  signed_out: 'Sign in first, then add Google sign-in.',
}

// The account's email, whether it is confirmed, changing it, and adding Google sign-in. Joining a team workspace
// needs a confirmed email.
export default function AccountPanel() {
  const [s, setS] = useState<Status | null>(null)
  const [msg, setMsg] = useState('')
  const [next, setNext] = useState('')
  useEffect(() => {
    void fetchStatus().then(setS)
    const g = new URLSearchParams(window.location.search).get('google')
    if (g && GOOGLE[g]) queueMicrotask(() => setMsg(GOOGLE[g]))
  }, [])
  async function post(path: string, body: unknown, done: (j: { sent?: boolean; message?: string }) => string) {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    setMsg(r.ok ? done(j) : j.error === 'reauth_required' ? 'Confirm it is you first (top of this page).' : j.error || 'Something went wrong')
  }
  if (!s) return null
  return (
    <div className="card p-6 mb-4">
      <h2 className="font-semibold mb-1">Account</h2>
      <p className="text-sm text-[#555]">{s.email} · {s.verified ? 'confirmed' : 'not confirmed yet'}{s.google ? ' · signs in with Google' : ''}</p>
      <div className="flex flex-wrap gap-3 mt-3 text-sm">
        {!s.verified && <button className="btn-primary" onClick={() => void post('/api/auth/email/send-verification', {}, j => j.sent ? `We sent a link to ${s.email}. It works for 24 hours.` : 'Already confirmed.')}>Send confirmation link</button>}
        {s.verified && !s.google && <a className="underline underline-offset-2" href="/api/auth/google?link=1">Add Google sign-in</a>}
      </div>
      <div className="flex flex-wrap gap-2 mt-3 text-sm">
        <input className="field flex-1 min-w-0" type="email" placeholder="New email address" value={next} onChange={e => setNext(e.target.value)} />
        <button className="btn-primary" disabled={!next.trim()} onClick={() => void post('/api/auth/email', { email: next }, j => { setNext(''); return j.message ?? 'Check the new address for a link.' })}>Change email</button>
      </div>
      {msg && <p className="text-sm text-[#555] mt-2">{msg}</p>}
    </div>
  )
}
