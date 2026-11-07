'use client'
import { useEffect, useState } from 'react'

type Status = 'scheduled' | 'ended' | 'held' | 'no_show' | 'cancelled' | 'rescheduled'
type Booking = { booking_uid: string; attendee_email: string; attendee_name: string | null; created_at: number; lead_id: string | null; company: string | null; lead_name: string | null; status: Status; start_at: number | null; end_at: number | null; rescheduled_to: string | null; rescheduled_from: string | null; manual_outcome: string | null }
type Manual = 'held' | 'no_show' | 'cancelled' | null

// What each status means to the user. 'ended' is Cal.com's end-of-slot notice: it does not prove anyone joined.
const LABEL: Record<Status, string> = {
  scheduled: 'scheduled', ended: 'slot ended - outcome not confirmed', held: 'held', no_show: 'no-show', cancelled: 'cancelled', rescheduled: 'rescheduled (see the new booking)',
}

export default function CalcomPanel() {
  const [st, setSt] = useState<{ configured: boolean; secret: string | null; secret_hidden?: boolean; webhook_url: string; bookings: Booking[]; loadedAt: number } | null>(null)
  const [msg, setMsg] = useState('')
  async function load() { const r = await fetch('/api/settings/calcom'); if (r.ok) setSt({ ...await r.json(), loadedAt: Date.now() }) }
  useEffect(() => { void load() }, [])
  async function rotate() {
    const r = await fetch('/api/settings/calcom', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'rotate' }) })
    setMsg(r.ok ? 'Secret ready - paste it into your Cal.com webhook.' : 'Something went wrong')
    void load()
  }
  async function reconcile(uid: string, outcome: Manual) {
    const r = await fetch('/api/settings/calcom', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'outcome', uid, outcome }) })
    const j = await r.json().catch(() => null) as { error?: string } | null
    setMsg(r.ok ? 'Booking outcome updated.' : j?.error || 'Something went wrong')
    void load()
  }
  if (!st) return null
  const canReconcile = !st.secret_hidden
  const over = (b: Booking) => b.status === 'ended' || (b.start_at !== null && b.start_at * 1000 <= st.loadedAt)
  return (
    <div className="card p-6 mb-4">
      <h2 className="font-semibold mb-1">Cal.com bookings</h2>
      <p className="text-[#555] text-sm mb-3">When someone books a call, the matching lead gets a &ldquo;booked call&rdquo; stage. A booking only matches when the attendee email matches exactly one lead&apos;s contact - anything else stays in the unmatched list below. Cancellations, reschedules and no-shows from Cal.com update the booking; a cancelled booking stops counting as booked (the lead&apos;s earlier stage comes back unless you changed it). Cal.com never confirms that a meeting took place, so mark held meetings here.</p>
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
              {b.attendee_name || b.attendee_email} - {b.lead_id ? <>matched to <span className="font-medium">{b.company || b.lead_name}</span></> : <span className="text-[#555]">no matching lead</span>}
              {' '}<span data-testid="booking-status">[{LABEL[b.status] ?? b.status}{b.manual_outcome ? ', set by hand' : ''}]</span>
              {' '}<span className="text-[#999] text-xs">{b.start_at !== null ? `meeting ${new Date(b.start_at * 1000).toLocaleString()}` : `received ${new Date(b.created_at * 1000).toLocaleDateString()}`}</span>
              {canReconcile && b.status !== 'rescheduled' && (
                <span className="ml-2 text-xs space-x-2">
                  {over(b) && b.status !== 'held' && <button className="underline underline-offset-2" onClick={() => reconcile(b.booking_uid, 'held')}>Mark held</button>}
                  {over(b) && b.status !== 'no_show' && <button className="underline underline-offset-2" onClick={() => reconcile(b.booking_uid, 'no_show')}>Mark no-show</button>}
                  {b.status !== 'cancelled' && <button className="underline underline-offset-2" onClick={() => reconcile(b.booking_uid, 'cancelled')}>Mark cancelled</button>}
                  {b.manual_outcome && <button className="underline underline-offset-2" onClick={() => reconcile(b.booking_uid, null)}>Undo manual outcome</button>}
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
