'use client'
import { useEffect, useState } from 'react'

interface St { enabled: boolean; paused: boolean; pause_reason: string | null; consent_current: boolean; daily_cap: number }
interface Info { available: boolean; state: St; consent: { version: string; text: string[] }; warmup: number; max_daily: number; audit: { action: string; detail: string | null; created_at: number }[] }
const KEYS = ['business_published', 'relevant_to_role', 'responsible_sender']
const LABELS = ['The addresses I target are published by the business for business use.', 'My emails are relevant to the recipient\'s role.', 'I am the sender and responsible for these emails.']

export default function AutopilotPanel() {
  const [i, setI] = useState<Info | null>(null)
  const [ack, setAck] = useState<boolean[]>([false, false, false])
  const [cap, setCap] = useState(20)
  const [msg, setMsg] = useState('')
  async function load() { const r = await fetch('/api/outreach/autopilot'); if (r.ok) setI(await r.json()) }
  useEffect(() => { void load() }, [])
  async function act(body: object) {
    const r = await fetch('/api/outreach/autopilot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    setMsg(r.ok ? '' : (await r.json()).error || 'Something went wrong'); void load()
  }
  if (!i || (!i.available && !i.state.enabled)) return null
  const s = i.state
  return (
    <div className="card p-6 mb-4">
      <h2 className="font-semibold mb-1">Autopilot (email)</h2>
      <p className="text-[#555] text-sm mb-3">dazl emails verified leads for you from your own Gmail, within daily limits. Off by default. Your first {i.warmup} sends still need your approval. Calls and social messages are not part of this.</p>
      {s.enabled ? (
        <div className="text-sm space-y-3">
          <div>{s.paused ? `Paused${s.pause_reason ? ` (${s.pause_reason.replace(/_/g, ' ')})` : ''}` : 'On'}. Up to {s.daily_cap} emails a day, one per company per week.</div>
          <div className="flex gap-4">
            {s.paused ? <button className="underline underline-offset-2" onClick={() => act({ action: 'resume' })}>Resume</button> : <button className="btn-primary" onClick={() => act({ action: 'pause' })}>Pause now</button>}
            <button className="underline underline-offset-2" onClick={() => act({ action: 'disable' })}>Turn off</button>
          </div>
        </div>
      ) : (
        <div className="text-sm space-y-2">
          <ul className="list-disc pl-5 text-[#555]">{i.consent.text.map((t, k) => <li key={k}>{t}</li>)}</ul>
          {KEYS.map((k, n) => <label key={k} className="flex gap-2 items-start"><input type="checkbox" checked={ack[n]} onChange={e => setAck(ack.map((v, m) => (m === n ? e.target.checked : v)))} /><span>{LABELS[n]}</span></label>)}
          <label className="flex gap-2 items-center">Daily limit <input className="field w-20" type="number" min={1} max={i.max_daily} value={cap} onChange={e => setCap(Number(e.target.value))} /></label>
          <button disabled={!ack.every(Boolean)} onClick={() => act({ action: 'enable', version: i.consent.version, attestations: KEYS, daily_cap: cap })} className="btn-primary disabled:opacity-40">Turn on autopilot</button>
        </div>
      )}
      {msg && <p className="text-sm text-[#555] mt-2">{msg}</p>}
      {i.audit.length > 0 && <details className="mt-3 text-sm"><summary className="cursor-pointer text-[#555]">Activity ({i.audit.length})</summary><ul className="mt-2 text-xs text-[#555] space-y-1">{i.audit.map((a, n) => <li key={n}>{new Date(a.created_at * 1000).toLocaleString()}: {a.action.replace(/_/g, ' ')}{a.detail ? ` (${a.detail})` : ''}</li>)}</ul></details>}
    </div>
  )
}
