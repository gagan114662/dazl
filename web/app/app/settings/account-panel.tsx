'use client'
import { useEffect, useState } from 'react'

const fetchStatus = (): Promise<{ email: string; verified: boolean; google: boolean } | null> =>
  fetch('/api/auth/email').then(r => r.ok ? r.json() : null).catch(() => null)

// The account's email and whether it is confirmed. Joining a team workspace needs a confirmed email.
export default function AccountPanel() {
  const [s, setS] = useState<{ email: string; verified: boolean; google: boolean } | null>(null)
  const [msg, setMsg] = useState('')
  useEffect(() => { void fetchStatus().then(setS) }, [])
  async function resend() {
    const r = await fetch('/api/auth/email/send-verification', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const j = await r.json().catch(() => ({}))
    setMsg(r.ok ? (j.sent ? `We sent a link to ${s?.email}. It works for 24 hours.` : 'Already confirmed.') : j.error || 'Something went wrong')
  }
  if (!s) return null
  return (
    <div className="card p-6 mb-4">
      <h2 className="font-semibold mb-1">Account</h2>
      <p className="text-sm text-[#555]">{s.email} · {s.verified ? 'confirmed' : 'not confirmed yet'}{s.google ? ' · signs in with Google' : ''}</p>
      {!s.verified && <button className="btn-primary mt-3" onClick={() => void resend()}>Send confirmation link</button>}
      {msg && <p className="text-sm text-[#555] mt-2">{msg}</p>}
    </div>
  )
}
