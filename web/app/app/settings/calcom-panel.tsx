'use client'
import { useEffect, useState } from 'react'

type Booking = { booking_uid: string; attendee_email: string; attendee_name: string | null; created_at: number; lead_id: string | null; company: string | null; lead_name: string | null; status: 'scheduled' | 'cancelled' | 'rescheduled'; start_at: number | null; outcome: 'held' | 'no_show' | null; outcome_source: 'calcom' | 'manual' | null }
type Counts = { scheduled: number; held: number; no_show: number; cancelled: number; rescheduled: number }

export default function CalcomPanel() {
  const [st, setSt] = useState<{ configured: boolean; secret: string | null; webhook_url: string; bookings: Booking[]; counts?: Counts } | null>(null)
  const [msg, setMsg] = useState('')
  // the page's clock, read once: which meetings have started (and can be marked held or no-show)
  const [now] = useState(() => Date.now())
  async function load() { const r = await fetch('/api/settings/calcom'); if (r.ok) setSt(await r.json()) }
  async function mark(uid: string, outcome: 'held' | 'no_show' | null) {
    const r = await fetch('/api/settings/calcom', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'outcome', booking_uid: uid, outcome }) })
    if (!r.ok) setMsg((await r.json().catch(() => ({}))).error || 'Could not record that')
    void load()
  }
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
          <div>Secret: <code className="text-xs break-all">{st.secret}</code></div>
          <button className="underline underline-offset-2" onClick={rotate}>Rotate secret</button>
        </div>
      ) : (
        <button className="btn-primary" onClick={rotate}>Set up the webhook</button>
      )}
      {st.counts && st.bookings.length > 0 && (
        <p className="text-xs text-[#555] mt-3" data-testid="booking-counts">{st.counts.scheduled} scheduled ({st.counts.held} held, {st.counts.no_show} no-show) · {st.counts.cancelled} cancelled · {st.counts.rescheduled} moved</p>
      )}
      {st.bookings.length > 0 && (
        <ul className="text-sm mt-3 space-y-2">
          {st.bookings.map(b => (
            <li key={b.booking_uid} data-testid="booking" className="[overflow-wrap:anywhere]">
              {b.attendee_name || b.attendee_email || 'Unknown attendee'} - {b.lead_id ? <>matched to <span className="font-medium">{b.company || b.lead_name}</span></> : <span className="text-[#555]">no matching lead</span>}
              {' '}<span className="text-[#999] text-xs">{b.start_at ? new Date(b.start_at * 1000).toLocaleString() : new Date(b.created_at * 1000).toLocaleDateString()}</span>
              {' '}<span className="badge" data-testid="booking-state">{b.status === 'cancelled' ? 'Cancelled' : b.status === 'rescheduled' ? 'Moved to another time' : b.outcome === 'held' ? 'Held' : b.outcome === 'no_show' ? 'No-show' : 'Scheduled'}</span>
              {b.status === 'scheduled' && b.start_at !== null && b.start_at * 1000 <= now && (
                // a meeting counts as held only when Cal.com says it ended or you say so here
                <span className="ml-2 text-xs">
                  {b.outcome !== 'held' && <button className="underline underline-offset-2 mr-2" onClick={() => void mark(b.booking_uid, 'held')}>Mark held</button>}
                  {b.outcome !== 'no_show' && <button className="underline underline-offset-2 mr-2" onClick={() => void mark(b.booking_uid, 'no_show')}>Mark no-show</button>}
                  {b.outcome && b.outcome_source === 'manual' && <button className="underline underline-offset-2" onClick={() => void mark(b.booking_uid, null)}>Clear</button>}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {msg && <p className="text-sm text-[#555] mt-2">{msg}</p>}
    </div>
  )
}
