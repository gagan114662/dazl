'use client'
import { useEffect, useState } from 'react'

// Changing keys, connectors, billing or members needs a sign-in within the last hour on this device. When any request
// on this page answers 403 reauth_required, this asks the person to confirm it is them (password, or Google again).
export default function ReauthGate() {
  const [method, setMethod] = useState<'password' | 'google' | null>(null)
  const [password, setPassword] = useState('')
  const [msg, setMsg] = useState('')
  useEffect(() => {
    const original = window.fetch
    const ask = () => void original('/api/auth/reauth').then(x => x.ok ? x.json() : null).catch(() => null)
      .then(info => { setMethod(info?.method === 'google' ? 'google' : 'password'); setMsg('') })
    // sent back here by a navigation that needed a recent sign-in (Gmail connect)
    if (new URLSearchParams(window.location.search).get('reauth') === '1') ask()
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const r = await original(...args)
      if (r.status === 403) {
        void r.clone().json().then(j => { if (j?.error === 'reauth_required') ask() }).catch(() => {})
      }
      return r
    }
    return () => { window.fetch = original }
  }, [])

  async function confirm() {
    const r = await fetch('/api/auth/reauth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) })
    const j = await r.json().catch(() => ({}))
    setPassword('')
    if (r.ok) { setMethod(null); setMsg('Confirmed for the next hour. Try that again.') } else setMsg(j.error || 'Could not confirm')
  }

  if (!method) return msg ? <p className="text-sm text-[#555] mb-4">{msg}</p> : null
  return (
    <div className="card p-6 mb-4 sticky top-2 z-10" role="alertdialog" aria-label="Confirm it is you">
      <h2 className="font-semibold mb-1">Confirm it is you</h2>
      <p className="text-[#555] text-sm mb-3">Changing keys, connectors, billing or members needs a recent sign-in on this device.</p>
      {method === 'password' ? (
        <div className="flex flex-wrap gap-2 text-sm">
          <input className="field flex-1 min-w-0" type="password" autoComplete="current-password" placeholder="Your password" value={password} onChange={e => setPassword(e.target.value)} />
          <button className="btn-primary" disabled={!password} onClick={() => void confirm()}>Confirm</button>
        </div>
      ) : <a className="btn-primary inline-block" href="/api/auth/google?reauth=1">Continue with Google</a>}
      {msg && <p className="text-sm text-[#555] mt-2">{msg}</p>}
    </div>
  )
}
