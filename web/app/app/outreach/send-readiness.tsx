'use client'
import { useEffect, useState } from 'react'
import SenderInline from '../sender-inline'

interface S { gmail: { email: string; status: string; read_granted: boolean } | null; sender: { sender_name: string; postal_address: string; booking_url?: string | null } | null }

// Request state for the settings read (#902): a failed read must say readiness could not be checked, never render
// nothing (which hides that sending may be blocked). The last confirmed settings stay on screen if a reload fails.
type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok' }

function isSettings(v: unknown): v is S {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
  if (!('gmail' in o && 'sender' in o)) return false
  const g = o.gmail, s = o.sender
  if (g !== null && !(obj(g) && typeof g.email === 'string' && typeof g.status === 'string' && typeof g.read_granted === 'boolean')) return false
  if (s !== null && !(obj(s) && typeof s.sender_name === 'string' && typeof s.postal_address === 'string' && (s.booking_url == null || typeof s.booking_url === 'string'))) return false
  return true
}

// Plain status of what is needed before anything can be sent. Signing in with Google proves identity only;
// Gmail is a separate, explicit grant made in Settings, so say so rather than leaving the user to find out at Send.
export default function SendReadiness() {
  const [s, setS] = useState<S | null>(null)
  const [state, setState] = useState<Load>({ kind: 'loading' })
  const load = async () => {
    setState({ kind: 'loading' })
    try {
      const r = await fetch('/api/outreach/settings')
      if (!r.ok) {
        setState({ kind: 'error', message: r.status === 401 || r.status === 403 ? 'Your session may have expired. Sign in again to check send readiness.' : `Could not check send readiness (error ${r.status}).` })
        return
      }
      let body: unknown
      try { body = await r.json() } catch { body = null }
      if (!isSettings(body)) { setState({ kind: 'error', message: 'Could not check send readiness (unexpected response).' }); return }
      setS(body); setState({ kind: 'ok' })
    } catch {
      setState({ kind: 'error', message: 'Could not check send readiness. Check your connection.' })
    }
  }
  // load() runs from a promise callback (not the effect body) so its state updates follow the request, per react-hooks/set-state-in-effect.
  useEffect(() => { void Promise.resolve().then(load) }, [])
  if (state.kind === 'error' && !s) return (
    <div className="card p-4 mb-4 text-sm" role="alert" data-testid="send-readiness-error">
      <p className="font-medium mb-1">Send readiness unknown</p>
      <p className="text-[#555] mb-2">{state.message} Nothing is sent from this page until you click Send.</p>
      <button type="button" className="underline underline-offset-2 min-h-[44px]" onClick={() => void load()}>Try again</button>
    </div>
  )
  if (!s) return <p className="text-xs text-[#666] mb-4" aria-live="polite" data-testid="send-readiness-loading">Checking send readiness…</p>
  const reloadError = state.kind === 'error'
    ? <p className="text-xs text-[#a33] mb-2" role="alert">{state.message} Showing the last confirmed status. <button type="button" className="underline" onClick={() => void load()}>Try again</button></p>
    : null
  const gmailOk = s.gmail?.status === 'active'
  const senderOk = !!s.sender?.sender_name && !!s.sender?.postal_address
  if (gmailOk && senderOk) return <>{reloadError}<p className="text-xs text-[#666] mb-4">Ready to send from {s.gmail!.email}. Manual emails send only after your click; autopilot, if you turn it on in Settings, can send first emails on its own. Reply reading is {s.gmail!.read_granted ? 'on' : 'off (optional)'}.</p></>
  return (
    <div className="card p-4 mb-4 text-sm">
      {reloadError}
      <p className="font-medium mb-1">Not ready to send yet</p>
      <ul className="list-disc pl-5 text-[#555] mb-2">
        {!s.gmail && <li>Gmail is not connected. Signing in with Google does not connect Gmail; it is a separate step you approve in Settings.</li>}
        {s.gmail && !gmailOk && <li>Gmail needs reconnecting.</li>}
        {!senderOk && <li>Add your name and mailing address below.</li>}
      </ul>
      {!senderOk && <div className="mb-3"><SenderInline initial={s.sender} onSaved={() => void load()} /></div>}
      {!gmailOk && <a className="underline underline-offset-2" href="/app/settings#gmail">Connect Gmail in Settings</a>}
    </div>
  )
}
