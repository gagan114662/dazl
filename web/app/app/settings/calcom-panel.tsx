'use client'
import { useEffect, useState } from 'react'
import { reconcileActions, type BookingStatus as Status } from '@/lib/calcom/outcome-rules'

type Booking = { booking_uid: string; attendee_email: string; attendee_name: string | null; created_at: number; lead_id: string | null; company: string | null; lead_name: string | null; status: Status; start_at: number | null; end_at: number | null; ended_at: number | null; rescheduled_to: string | null; rescheduled_from: string | null; manual_outcome: string | null }
type Manual = 'held' | 'no_show' | 'cancelled' | null

// What each status means to the user. 'ended' is Cal.com's end-of-slot notice: it does not prove anyone joined.
const LABEL: Record<Status, string> = {
  scheduled: 'scheduled', ended: 'slot ended - outcome not confirmed', held: 'held', no_show: 'no-show', cancelled: 'cancelled', rescheduled: 'rescheduled (see the new booking)',
}

export default function CalcomPanel() {
  const [st, setSt] = useState<{ configured: boolean; can_configure: boolean; secret: string | null; secret_hidden?: boolean; webhook_url: string; bookings: Booking[]; now: number } | null>(null)
  const [msg, setMsg] = useState('')
  const fetchState = () => fetch('/api/settings/calcom').then(r => (r.ok ? r.json() : null)).then(j => { if (j) setSt(j) }).catch(() => {})
  async function load() { await fetchState() }
  useEffect(() => { void fetchState() }, [])
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
  // Controls follow the server: can_configure is the POST route's gate, reconcileActions the same meeting-over rule
  // setManualOutcome applies (held / no-show only once the meeting's end has passed or Cal.com reported it ended).
  const canConfigure = st.can_configure === true
  const nowS = st.now // the server's clock (GET), the one setManualOutcome checks: a browser clock that is off does not move the buttons
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
          {canConfigure && <button className="underline underline-offset-2" onClick={rotate}>Rotate secret</button>}
        </div>
      ) : canConfigure ? (
        <button className="btn-primary" onClick={rotate}>Set up the webhook</button>
      ) : (
        <div className="text-sm text-[#555]">Not set up yet. Only admins and owners of this workspace can set up the webhook.</div>
      )}
      {st.bookings.length > 0 && (
        <ul className="text-sm mt-3 space-y-1">
          {st.bookings.map(b => { const acts = reconcileActions(b, canConfigure, nowS); return (
            <li key={b.booking_uid}>
              {b.attendee_name || b.attendee_email || 'Attendee not known yet'} - {b.lead_id ? <>matched to <span className="font-medium">{b.company || b.lead_name}</span></> : <span className="text-[#555]">no matching lead</span>}
              {' '}<span data-testid="booking-status">[{LABEL[b.status] ?? b.status}{b.manual_outcome ? ', set by hand' : ''}]</span>
              {' '}<span className="text-[#999] text-xs">{b.start_at !== null ? `meeting ${new Date(b.start_at * 1000).toLocaleString()}` : `received ${new Date(b.created_at * 1000).toLocaleDateString()}`}</span>
              {acts.length > 0 && (
                <span className="ml-2 text-xs space-x-2">
                  {acts.includes('held') && <button className="underline underline-offset-2" onClick={() => reconcile(b.booking_uid, 'held')}>Mark held</button>}
                  {acts.includes('no_show') && <button className="underline underline-offset-2" onClick={() => reconcile(b.booking_uid, 'no_show')}>Mark no-show</button>}
                  {acts.includes('cancelled') && <button className="underline underline-offset-2" onClick={() => reconcile(b.booking_uid, 'cancelled')}>Mark cancelled</button>}
                  {acts.includes('clear') && <button className="underline underline-offset-2" onClick={() => reconcile(b.booking_uid, null)}>Undo manual outcome</button>}
                </span>
              )}
            </li>
          ) })}
        </ul>
      )}
      {msg && <p className="text-sm text-[#555] mt-2">{msg}</p>}
    </div>
  )
}
