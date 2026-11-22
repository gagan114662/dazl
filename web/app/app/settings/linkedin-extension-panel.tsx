'use client'
import { useEffect, useState } from 'react'

// Settings > LinkedIn extension (#1122). The dazl LinkedIn Reader reads company People pages, profiles and post comments in the
// user's own browser, at the pace dazl's server sets. Here: create the token (shown once), revoke it, pause or resume.
type Status = { token: boolean; created_at: number | null; last_used_at: number | null; tz: string | null; paused: boolean; queued: number; read_today: number }

export default function LinkedInExtensionPanel() {
  const [st, setSt] = useState<Status | null>(null)
  const [token, setToken] = useState('')
  const [msg, setMsg] = useState('')
  const load = () => fetch('/api/settings/extension').then(r => (r.ok ? r.json() : null)).then(j => setSt(j)).catch(() => setSt(null))
  useEffect(() => { void load() }, [])
  async function act(action: string) {
    setMsg('')
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const r = await fetch('/api/settings/extension', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, timezone }) })
    const j = await r.json().catch(() => null)
    if (!r.ok) { setMsg(j?.error || 'Could not save'); return }
    if (action === 'create') setToken(j.token)
    if (action === 'revoke') setToken('')
    await load()
  }
  if (!st) return null
  return (
    <div id="linkedin-extension" className="card p-6 mb-4 scroll-mt-6">
      <h2 className="font-semibold mb-1">LinkedIn extension</h2>
      <p className="text-[#555] text-sm mb-4">
        The dazl LinkedIn Reader finds the right buyer at each company by reading its LinkedIn People page in your own browser. Up to 40 pages a day,
        9am to 5pm{st.tz ? ` (${st.tz})` : ''}, one at a time. It only reads; it never connects or messages anyone.
      </p>
      {token && (
        <div className="mb-3" data-testid="extension-token">
          <p className="text-sm mb-1">Your token. Copy it now; it is shown only once.</p>
          <input className="input w-full font-mono text-xs" readOnly value={token} onFocus={e => e.currentTarget.select()} />
        </div>
      )}
      {st.token && <p className="text-sm text-[#555] mb-3">{st.paused ? 'Paused.' : 'On.'} {st.read_today} pages read today, {st.queued} waiting.</p>}
      <div className="flex gap-2 flex-wrap">
        <button className="btn-primary" type="button" onClick={() => act('create')}>{st.token ? 'Create a new token' : 'Create token'}</button>
        {st.token && <button className="btn-ghost" type="button" onClick={() => act(st.paused ? 'resume' : 'pause')}>{st.paused ? 'Resume' : 'Pause'}</button>}
        {st.token && <button className="btn-ghost" type="button" onClick={() => act('revoke')}>Revoke</button>}
      </div>
      {msg && <p className="text-sm text-[#555] mt-3">{msg}</p>}
    </div>
  )
}
