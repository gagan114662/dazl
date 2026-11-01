'use client'
import { useEffect, useState } from 'react'
import Caveat from '@/app/app/caveat'

interface State { gmail: { email: string; status: string; read_granted: boolean } | null; sender: { sender_name: string; postal_address: string; booking_url?: string | null } | null; daily_cap: number; sent_24h: number; read_notice: string[] }

export default function GmailPanel() {
  const [s, setS] = useState<State | null>(null)
  const [name, setName] = useState('')
  const [addr, setAddr] = useState('')
  const [booking, setBooking] = useState('')
  const [msg, setMsg] = useState('')
  const [justConnected, setJustConnected] = useState(false) // back from Google's grant: offer the way back to the emails

  async function load() {
    const r = await fetch('/api/outreach/settings')
    if (!r.ok) return
    const j: State = await r.json()
    setS(j)
    setName(n => n || j.sender?.sender_name || '')
    setAddr(a => a || j.sender?.postal_address || '')
    setBooking(b => b || j.sender?.booking_url || '')
  }
  useEffect(() => {
    void load()
    const q = new URLSearchParams(window.location.search).get('gmail')
    // Google's redirect lands at the top of Settings: bring this panel (and its next step) into view.
    // The sections above load on their own and can push it back down, so it keeps its place while they settle
    // (up to 3s), unless the user scrolls first.
    if (q) {
      const el = document.getElementById('gmail'), page = el?.closest('main')?.firstElementChild
      const put = () => el?.scrollIntoView({ block: 'start' })
      setTimeout(put, 0)
      if (page && typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(put); ro.observe(page)
        const stop = () => { ro.disconnect(); window.removeEventListener('wheel', stop); window.removeEventListener('touchstart', stop); window.removeEventListener('keydown', stop) }
        window.addEventListener('wheel', stop, { passive: true }); window.addEventListener('touchstart', stop, { passive: true }); window.addEventListener('keydown', stop)
        setTimeout(stop, 3000)
      }
    }
    if (q === 'connected') { setMsg('Gmail connected.'); setJustConnected(true) }
    else if (q) setMsg('Gmail was not connected. Try again.')
  }, [])

  async function saveSender(e: React.FormEvent) {
    e.preventDefault()
    const r = await fetch('/api/outreach/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sender_name: name, postal_address: addr, booking_url: booking }) })
    setMsg(r.ok ? 'Saved.' : (await r.json()).error || 'Could not save')
    void load()
  }
  async function disconnect() {
    await fetch('/api/gmail/disconnect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    void load()
  }

  const field = 'bg-white border border-black/20 rounded px-4 py-2.5 text-[#111] text-sm'
  return (
    <div className="card p-6 mb-4">
      <h2 className="font-semibold mb-1">Email sending (Gmail)</h2>
      <Caveat className="text-[#555] text-sm mb-4" summary="Emails go out from your own Gmail after you approve them (or on autopilot, if you turn it on), and connecting asks to read replies in dazl outreach threads and check delivery-failure notices for its sends.">Emails go out from your own Gmail. By default each one is sent after you approve it; if you turn on autopilot below, it can send first emails on its own within the limits you set. Connecting also asks for read access, limited to replies in the threads dazl started for you and delivery-failure notices for them - To find separate-thread delivery failures, dazl searches mailer-daemon and postmaster notices in a bounded time window and checks whether they match its recorded sends. Unmatched notice content is not kept as a reply. On Google&apos;s consent screen you can untick the read access and still connect send-only.</Caveat>
      {s?.gmail ? (
        <div className="text-sm mb-4">
          <div className="flex items-center justify-between">
            <span>{s.gmail.email} {s.gmail.status === 'active' ? '(connected)' : '(needs reconnecting)'}</span>
            <span className="flex gap-3">
              {(s.gmail.status !== 'active' || !s.gmail.read_granted) && <a href="/api/gmail/connect" className="underline text-[#111]">Reconnect</a>}
              <button onClick={disconnect} className="underline text-[#111]">Disconnect</button>
            </span>
          </div>
          {s.gmail.status === 'active' && (
            <p className="text-[#666] text-xs mt-1">{s.gmail.read_granted ? 'Reply reading: on. Only threads dazl started are read.' : 'Reply reading: off (send only). Reconnect and leave the read access ticked to turn it on.'}</p>
          )}
        </div>
      ) : (
        <div className="mb-4">
          {s?.read_notice && <ul className="list-disc pl-5 text-[#555] text-sm mb-3 space-y-1">{s.read_notice.map((t, k) => <li key={k}>{t}</li>)}</ul>}
          <a href="/api/gmail/connect" className="inline-block btn-primary px-5 py-2 text-sm">Connect Gmail</a>
          <p className="text-[#666] text-xs mt-2">Connecting means you agree to the reply-reading above. You can withdraw it any time in Settings.</p>
        </div>
      )}
      <form onSubmit={saveSender} className="flex flex-col gap-3">
        <input className={field} placeholder="Name recipients see (e.g. Pat Smith, Acme Roofing)" value={name} maxLength={100} onChange={e => setName(e.target.value)} />
        <input className={field} placeholder="Mailing address (required in every email by law)" value={addr} maxLength={300} onChange={e => setAddr(e.target.value)} />
        <input className={field} type="url" placeholder="Booking link, optional (https://cal.com/you or https://calendly.com/you) - included in automatic follow-ups" value={booking} maxLength={300} onChange={e => setBooking(e.target.value)} />
        <button className="btn-ghost px-5 py-2 text-sm w-fit">Save sender details</button>
      </form>
      {s && <p className="text-[#666] text-xs mt-3">Sent in the last 24 hours: {s.sent_24h} of {s.daily_cap}.</p>}
      {msg && <p className="text-sm text-[#555] mt-2" role="status">{msg}{justConnected && <> <a className="underline text-[#111]" href="/app/outreach">Back to Outreach to send your approved emails</a></>}</p>}
    </div>
  )
}
