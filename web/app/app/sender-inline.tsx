'use client'
import { useState } from 'react'

// Sender name and mailing address, asked where sending needs them instead of sending the user to Settings.
// Same PUT /api/outreach/settings and the same server checks as Settings; the existing booking link is kept.
export default function SenderInline({ initial, onSaved }: { initial?: { sender_name?: string; postal_address?: string; booking_url?: string | null } | null; onSaved: () => void }) {
  const [name, setName] = useState(initial?.sender_name ?? '')
  const [address, setAddress] = useState(initial?.postal_address ?? '')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg('')
    try {
      const r = await fetch('/api/outreach/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sender_name: name, postal_address: address, booking_url: initial?.booking_url ?? '' }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) return setMsg(j.error || 'Could not save')
      window.dispatchEvent(new Event('sender-updated'))
      onSaved()
    } catch { setMsg('Could not reach the server. Try again.') } finally { setBusy(false) }
  }
  return (
    <form onSubmit={save} className="flex flex-col gap-2 text-sm" aria-label="Sender details">
      <p className="text-xs text-[#555]">Every email ends with your name, mailing address and an unsubscribe link (anti-spam law). Add them once.</p>
      <input className="field" required maxLength={100} placeholder="Your name, as recipients will see it" value={name} onChange={e => setName(e.target.value)} />
      <input className="field" required minLength={10} maxLength={300} placeholder="Mailing address, e.g. 1 Main St, Columbus, OH 43004, USA" value={address} onChange={e => setAddress(e.target.value)} />
      <div className="flex items-center gap-3">
        <button className="btn-primary text-xs px-3 py-1.5 w-fit" disabled={busy || !name.trim() || address.trim().length < 10}>{busy ? 'Saving...' : 'Save sender details'}</button>
        {msg && <span className="text-xs text-[#111]" role="status">{msg}</span>}
      </div>
    </form>
  )
}
