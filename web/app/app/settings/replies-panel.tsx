'use client'
import { useEffect, useState } from 'react'

interface Info { available: boolean; gmail_connected: boolean; consent: { version: string; text: string[]; accepted: boolean }; read_granted: boolean; followups_enabled: boolean; autopilot_on: boolean; inbound: { from_email: string; excerpt: string; classification: string; received_at: number }[] }

export default function RepliesPanel() {
  const [i, setI] = useState<Info | null>(null)
  const [msg, setMsg] = useState('')
  async function load() { const r = await fetch('/api/outreach/replies'); if (r.ok) setI(await r.json()) }
  useEffect(() => { void load() }, [])
  async function act(action: string) {
    const r = await fetch('/api/outreach/replies', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, accept: true, version: i?.consent.version }) })
    const j = await r.json().catch(() => ({})); setMsg(r.ok ? (action === 'sync' ? 'Checked replies.' : '') : j.error || 'Something went wrong'); void load()
  }
  if (!i || !i.available) return null
  return (
    <div className="card p-6 mb-4">
      <h2 className="font-semibold mb-1">Replies and follow-ups</h2>
      <p className="text-[#555] text-sm mb-3">Lets dazl stop emailing people who unsubscribe or bounce, and follow up with people who replied with interest. Needs read access to the threads dazl started.</p>
      {!i.gmail_connected ? (
        <div className="text-sm space-y-2">
          <ul className="list-disc pl-5 text-[#555]">{i.consent.text.map((t, k) => <li key={k}>{t}</li>)}</ul>
          <a className="btn-primary inline-block" href="/api/gmail/connect">Connect Gmail</a>
          <p className="text-xs text-[#888]">Connecting means you agree to the reply-reading above. On Google&apos;s screen you can untick the read access and still connect send-only.</p>
        </div>
      ) : !i.read_granted ? (
        <div className="text-sm space-y-2">
          <p className="text-[#555]">Gmail is connected send-only (the read access was unticked on Google&apos;s screen, or it predates reply reading). Reconnect and leave the read access ticked to turn on reply reading.</p>
          <a className="btn-primary inline-block" href="/api/gmail/connect">Reconnect Gmail with reply access</a>
        </div>
      ) : (
        <div className="text-sm space-y-2">
          <div>Reading replies: on. Follow-ups: {i.followups_enabled ? 'on' : 'off'}. Up to 2 follow-ups, only to people who showed interest, never after they opt out.</div>
          <div className="flex gap-4">
            <button className="underline underline-offset-2" onClick={() => act('sync')}>Check replies now</button>
            {i.followups_enabled ? <button className="underline underline-offset-2" onClick={() => act('followups_off')}>Turn off follow-ups</button> : <button className="underline underline-offset-2" disabled={!i.autopilot_on} onClick={() => act('followups_on')}>{i.autopilot_on ? 'Turn on follow-ups' : 'Turn on autopilot first'}</button>}
            <button className="underline underline-offset-2" onClick={() => act('revoke')}>Stop reading replies</button>
          </div>
        </div>
      )}
      {msg && <p className="text-sm text-[#555] mt-2">{msg}</p>}
      {i.inbound.length > 0 && <details className="mt-3 text-sm"><summary className="cursor-pointer text-[#555]">Recent replies ({i.inbound.length})</summary><ul className="mt-2 text-xs text-[#555] space-y-1">{i.inbound.map((m, n) => <li key={n}>{new Date(m.received_at * 1000).toLocaleString()}: {m.from_email}, {m.classification.replace(/_/g, ' ')}: {m.excerpt}</li>)}</ul></details>}
    </div>
  )
}
