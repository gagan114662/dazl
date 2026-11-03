'use client'
import { useEffect, useState } from 'react'

type Booking = { booking_uid: string; attendee_email: string; attendee_name: string | null; created_at: number; lead_id: string | null; company: string | null; lead_name: string | null }

export default function CalcomPanel() {
  const [st, setSt] = useState<{ configured: boolean; secret: string | null; secret_hidden?: boolean; webhook_url: string; bookings: Booking[] } | null>(null)
  const [msg, setMsg] = useState('')
  async function load() { const r = await fetch('/api/settings/calcom'); if (r.ok) setSt(await r.json()) }
  useEffect(() => { void load() }, [])
  async function rotate() {
    const r = await fetch('/api/settings/calcom', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'rotate' }) })
    setMsg(r.ok ? 'Secret ready - paste it into your Cal.com webhook.' : 'Something went wrong')
    void load()
  }
  if (!st) return null
  return (
    <div className="card p-6 mb-4">
      <h2 className="font-semibold mb-1">Cal.com bookings</h2>
      <p className="text-[#555] text-sm mb-3">When someone books a call, the matching lead gets a "booked call" stage. A booking only matches when the attendee email matches exactly one lead's contact - anything else stays in the unmatched list below.</p>
      {st.configured ? (
        <div className="text-sm space-y-2">
          <div>Webhook URL: <code className="text-xs break-all">{st.webhook_url}</code></div>
          {st.secret_hidden
            ? <div className="text-[#555]">Only admins and owners of this workspace see the signing secret.</div>
            : <div>Secret: <code className="text-xs break-all">{st.secret}</code></div>}
          {!st.secret_hidden && <button className="underline underline-offset-2" onClick={rotate}>Rotate secret</button>}
        </div>
      ) : (
        <button className="btn-primary" onClick={rotate}>Set up the webhook</button>
      )}
      {st.bookings.length > 0 && (
        <ul className="text-sm mt-3 space-y-1">
          {st.bookings.map(b => (
            <li key={b.booking_uid}>
              {b.attendee_name || b.attendee_email} - {b.lead_id ? <>matched to <span className="font-medium">{b.company || b.lead_name}</span> (booked call)</> : <span className="text-[#555]">no matching lead</span>}
              {' '}<span className="text-[#999] text-xs">{new Date(b.created_at * 1000).toLocaleDateString()}</span>
            </li>
          ))}
        </ul>
      )}
      {msg && <p className="text-sm text-[#555] mt-2">{msg}</p>}
    </div>
  )
}
