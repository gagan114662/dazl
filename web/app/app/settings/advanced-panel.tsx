'use client'
import { useEffect, useState } from 'react'
import { CHANNELS, TIER_LABEL, type Channel } from '@/lib/channels'
import Caveat from '@/app/app/caveat'

interface P { platform: string; allowed: boolean; supported?: boolean; unsupported_reason?: string | null; consent: boolean; connected: boolean; enabled: boolean; last4: string | null; high_risk: boolean }
const NAMES: Record<string, string> = { linkedin: 'LinkedIn', x: 'X', reddit: 'Reddit', xiaohongshu: 'XiaoHongShu', bilibili: 'Bilibili' }
const BADGE = { live: 'Working', worker: 'Needs worker', soon: 'Coming soon' } as const

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
  if (!st) return null
  function Row(c: Channel, p: P) {
    return (
      <>
        {p.supported === false ? (
          <p className="text-[#555]">Not available yet - dazl cannot read {c.name}{p.unsupported_reason ? `: ${p.unsupported_reason}` : ''}. Connecting a session is off for it.</p>
        ) : !p.allowed ? (
          <p className="text-[#555]">Off on this server. The operator turns it on with ADVANCED_CONNECTORS.</p>
        ) : !p.consent ? (
          <div className="flex flex-col gap-2">
            <label className="flex gap-2 items-start"><input type="checkbox" checked={!!ack[p.platform]} onChange={e => setAck({ ...ack, [p.platform]: e.target.checked })} /><span>I understand this can violate {c.name}&apos;s terms and get my account banned, and I am using a throwaway account.</span></label>
            <button disabled={!ack[p.platform]} onClick={() => post({ action: 'consent', platform: p.platform, accept: true, version: st!.version })} className="btn-primary w-fit disabled:opacity-40">Accept and continue</button>
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
          <form method="post" className="flex flex-col gap-2" autoComplete="off" onSubmit={async e => { e.preventDefault(); if (await post({ action: 'save', platform: p.platform, session: session[p.platform] ?? '' })) setSession({ ...session, [p.platform]: '' }) }}>
            <input className="field" type="password" autoComplete="off" placeholder="Paste the session cookie for the throwaway account" value={session[p.platform] ?? ''} onChange={e => setSession({ ...session, [p.platform]: e.target.value })} />
            <button className="btn-primary w-fit">Connect {c.name}</button>
          </form>
        )}
      </>
    )
  }
  return (
    <div id="connectors" className="card p-6 mb-4 scroll-mt-6">
      <h2 className="font-semibold mb-1">Connectors</h2>
      <Caveat className="text-[#555] text-sm mb-3" summary="dazl reads public web pages for free; optional session channels stay off until you accept the risk notice.">dazl reads public web pages for free. No paid lookup service is used and no outside API key is needed. Tier 0 channels need no setup. Session channels are optional and stay off until you accept the risk notice and connect your own account.</Caveat>
      <Caveat className="text-[#555] text-sm mb-3" summary="Session channels break most platforms' terms and can get the account you use limited or banned - use a throwaway account, never your main one.">Session channels use your own logged-in session on a platform to find leads there. This breaks the terms of most of these platforms. They can limit or ban the account you use. Use a throwaway account, never your main one. You accept that risk yourself; dazl cannot protect your account.</Caveat>
      <Caveat className="text-[#555] text-sm mb-4" summary="Your session is encrypted and used only for your scans; leads from pages behind a login always go to needs review.">Your session is encrypted, used only for your scans, rate limited, and logged below your scans in the lookup history. Leads from pages behind a login are never verified automatically. They go to needs review. Remove a session at any time.</Caveat>
      {([0, 1, 2] as const).map(t => (
        <div key={t} className="mt-5">
          <div className="text-xs font-mono uppercase tracking-wider text-[#555] mb-1">{TIER_LABEL[t]}</div>
          {CHANNELS.filter(c => c.tier === t).map(c => {
            const p = c.platform ? st.platforms.find(x => x.platform === c.platform) : undefined
            return (
              <div key={c.id} className="border-t border-[#ddd] pt-3 mt-3 text-sm">
                <div className="flex items-center justify-between gap-3 mb-1">
                  <span className="font-medium">{c.name}</span>
                  <span className="badge">{BADGE[c.status]}</span>
                </div>
                <p className="text-[#555] mb-2">{c.note}</p>
                {p && Row(c, p)}
              </div>
            )
          })}
        </div>
      ))}
      {msg && <p className="text-sm text-[#555] mt-3">{msg}</p>}
    </div>
  )
}
