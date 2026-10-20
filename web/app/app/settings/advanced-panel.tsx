'use client'
import { useEffect, useState } from 'react'

interface P { platform: string; consent: boolean; connected: boolean; enabled: boolean; last4: string | null; high_risk: boolean }
const NAMES: Record<string, string> = { x: 'X', reddit: 'Reddit', xiaohongshu: 'Xiaohongshu', bilibili: 'Bilibili', linkedin: 'LinkedIn' }

export default function AdvancedPanel() {
  const [st, setSt] = useState<{ available: boolean; version: string; platforms: P[] } | null>(null)
  const [session, setSession] = useState<Record<string, string>>({})
  const [ack, setAck] = useState<Record<string, boolean>>({})
  const [msg, setMsg] = useState('')

  async function load() { const r = await fetch('/api/settings/advanced'); if (r.ok) setSt(await r.json()) }
  useEffect(() => { void load() }, [])
  async function post(body: object) {
    const r = await fetch('/api/settings/advanced', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const j = await r.json(); setMsg(r.ok ? '' : j.error || 'Something went wrong'); void load(); return r.ok
  }
  if (!st || !st.available) return null
  return (
    <div className="card p-6 mb-4">
      <h2 className="font-semibold mb-1">Advanced connectors</h2>
      <p className="text-[#555] text-sm mb-3">Use your own logged-in session on a platform to find leads there. This breaks the terms of most of these platforms. They can limit or ban the account you use. Use a throwaway account, never your main one. You accept that risk yourself; dazl cannot protect your account.</p>
      <p className="text-[#555] text-sm mb-4">Your session is encrypted, used only for your scans, rate limited, and logged below your scans in the lookup history. Leads from pages behind a login are never verified automatically. They go to needs review. Remove a session at any time.</p>
      {st.platforms.map(p => (
        <div key={p.platform} className="border-t border-[#ddd] pt-3 mt-3 text-sm">
          <div className="font-medium mb-1">{NAMES[p.platform] ?? p.platform}{p.high_risk && ' (highest risk)'}</div>
          {p.high_risk && <p className="text-[#555] mb-2">LinkedIn restricts automated access in its user agreement and is known to ban accounts quickly. Only use an account you can lose.</p>}
          {!p.consent ? (
            <div className="flex flex-col gap-2">
              <label className="flex gap-2 items-start"><input type="checkbox" checked={!!ack[p.platform]} onChange={e => setAck({ ...ack, [p.platform]: e.target.checked })} /><span>I understand this can violate {NAMES[p.platform]}&apos;s terms and get my account banned, and I am using a throwaway account.</span></label>
              <button disabled={!ack[p.platform]} onClick={() => post({ action: 'consent', platform: p.platform, accept: true, version: st.version })} className="btn-primary w-fit disabled:opacity-40">Accept and continue</button>
            </div>
          ) : p.connected ? (
            <div className="flex items-center justify-between gap-3">
              <span>Session ending in {p.last4}, {p.enabled ? 'on' : 'off'}</span>
              <span className="flex gap-4">
                <button className="underline underline-offset-2" onClick={() => post({ action: 'toggle', platform: p.platform, enabled: !p.enabled })}>{p.enabled ? 'Turn off' : 'Turn on'}</button>
                <button className="underline underline-offset-2" onClick={async () => { await fetch(`/api/settings/advanced?platform=${p.platform}`, { method: 'DELETE' }); void load() }}>Remove</button>
                <button className="underline underline-offset-2" onClick={() => post({ action: 'revoke', platform: p.platform })}>Withdraw consent</button>
              </span>
            </div>
          ) : (
            <form className="flex flex-col gap-2" autoComplete="off" onSubmit={async e => { e.preventDefault(); if (await post({ action: 'save', platform: p.platform, session: session[p.platform] ?? '' })) setSession({ ...session, [p.platform]: '' }) }}>
              <input className="field" type="password" autoComplete="off" placeholder="Paste the session cookie for the throwaway account" value={session[p.platform] ?? ''} onChange={e => setSession({ ...session, [p.platform]: e.target.value })} />
              <button className="btn-primary w-fit">Save session</button>
            </form>
          )}
        </div>
      ))}
      {msg && <p className="text-sm text-[#555] mt-3">{msg}</p>}
    </div>
  )
}
