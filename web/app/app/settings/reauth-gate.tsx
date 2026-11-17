'use client'
import { useEffect, useRef, useState } from 'react'
import { watchReauth, type ReauthMethod } from './reauth-prompt'

// Changing keys, connectors, billing or members needs a sign-in within the last hour on this device. When any request
// on this page answers 403 reauth_required, this asks the person to confirm it is them (password, or Google again).
export default function ReauthGate() {
  const [method, setMethod] = useState<ReauthMethod | null>(null)
  const [asks, setAsks] = useState(0)
  const [password, setPassword] = useState('')
  const [msg, setMsg] = useState('')
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const original = window.fetch
    const w = watchReauth(original, (m, seq) => { setMethod(m); setAsks(seq); setMsg('') })
    // sent back here by a navigation that needed a recent sign-in (Gmail connect)
    if (new URLSearchParams(window.location.search).get('reauth') === '1') void w.ask()
    window.fetch = w.fetch
    return () => { window.fetch = original }
  }, [])

  // #719: the dialog sits in the page flow at the top (never pinned over the form that asked) and is scrolled into
  // view on EVERY reauth_required answer, including a repeat with the same method (F1).
  useEffect(() => { if (method) box.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, [method, asks])

  async function confirm() {
    const r = await fetch('/api/auth/reauth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) })
    const j = await r.json().catch(() => ({}))
    setPassword('')
    if (r.ok) { setMethod(null); setMsg('Confirmed for the next hour. Try that again.') } else setMsg(j.error || 'Could not confirm')
  }

  if (!method) return msg ? <p className="text-sm text-[#555] mb-4">{msg}</p> : null
  return (
    <div ref={box} className="card p-6 mb-4 scroll-mt-2" role="alertdialog" aria-label="Confirm it is you">
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
