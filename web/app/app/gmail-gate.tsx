'use client'
import { useEffect, useState } from 'react'

interface RepliesInfo { available: boolean; consent: { version: string; text: string[]; accepted: boolean }; read_granted: boolean }

// Inline path for pages that need Gmail reply access: consent (with the real text) then
// the Connect Gmail button. Renders nothing once read access is granted.
export default function GmailGate({ intro }: { intro: string }) {
  const [i, setI] = useState<RepliesInfo | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { fetch('/api/outreach/replies').then(r => r.ok ? r.json() : null).then(setI).catch(() => {}) }, [])
  if (!i || !i.available) return null
  if (i.consent.accepted && i.read_granted) return null
  async function agree() {
    setBusy(true)
    const r = await fetch('/api/outreach/replies', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'consent', accept: true, version: i?.consent.version }) })
    setBusy(false)
    if (r.ok && i) setI({ ...i, consent: { ...i.consent, accepted: true } })
  }
  return (
    <div className="card p-6 text-sm">
      <p className="font-medium mb-2">{intro}</p>
      {!i.consent.accepted ? (
        <>
          <ul className="list-disc pl-5 text-[#555] mb-3">{i.consent.text.map((t, k) => <li key={k}>{t}</li>)}</ul>
          <button className="btn-primary" disabled={busy} onClick={agree}>{busy ? 'Saving...' : 'I agree'}</button>
        </>
      ) : (
        <a className="btn-primary inline-block" href="/api/gmail/connect?read=1">Connect Gmail</a>
      )}
    </div>
  )
}
