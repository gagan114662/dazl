'use client'
import { useEffect, useState } from 'react'
import LinkedinConnect, { type ConnectState } from './linkedin-connect'

// Settings > LinkedIn reading (#1122). The dazl Connect extension reads company People pages, profiles and post comments in the
// user's own browser, at the pace dazl's server sets. Here: the reading hours, a later end for tonight only, pause / resume.
type Status = { available?: boolean; consent?: boolean; consent_version?: string; connect?: ConnectState | null; connected: boolean; tz: string | null; paused: boolean; queued: number; read_today: number; open_min: number; close_min: number; today_close_min: number | null; stopped_until: number | null }
const hm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`)

export default function LinkedInExtensionPanel() {
  const [st, setSt] = useState<Status | null>(null)
  const [msg, setMsg] = useState('')
  const [ack, setAck] = useState(false)
  const [open, setOpen] = useState('09:00'), [close, setClose] = useState('17:00'), [tonight, setTonight] = useState('22:00')
  const load = () => fetch('/api/settings/extension').then(r => (r.ok ? r.json() : null)).then((j: Status | null) => {
    setSt(j); if (j) { setOpen(hm(j.open_min)); setClose(hm(j.close_min)) }
  }).catch(() => setSt(null))
  useEffect(() => { void load() }, [])
  async function act(body: Record<string, string>) {
    setMsg('')
    const r = await fetch('/api/settings/extension', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const j = await r.json().catch(() => null)
    setMsg(r.ok ? 'Saved.' : j?.error || 'Could not save')
    await load()
  }
  if (!st || st.available === false) return null
  // Not connected yet: every workspace connects its own LinkedIn here. The notice is accepted once, then one click pairs the extension.
  if (!st.connected) return (
    <div id="linkedin-reading" className="card p-6 mb-4 scroll-mt-6" data-testid="linkedin-pairing">
      <h2 className="font-semibold mb-1">Connect LinkedIn</h2>
      <p className="text-[#555] text-sm mb-3">
        The dazl Connect extension reads LinkedIn in your own Chrome, with your own sign-in: company People pages, profiles and the comments on a post,
        one page at a time, up to 40 a day, inside the reading hours you set. It only reads. dazl never gets your LinkedIn password or cookies.
      </p>
      {!st.consent ? (
        <div className="flex flex-col gap-2 text-sm">
          <label className="flex gap-2 items-start"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} /><span>I understand that automated reading can break LinkedIn&apos;s terms, and that LinkedIn may limit or restrict the account I use.</span></label>
          <button type="button" disabled={!ack} className="btn-primary w-fit disabled:opacity-40" data-testid="linkedin-accept" onClick={async () => {
            const r = await fetch('/api/settings/advanced', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'consent', platform: 'linkedin', accept: true, version: st.consent_version }) })
            const j = await r.json().catch(() => null); setMsg(r.ok ? '' : j?.error || 'Could not save'); await load()
          }}>Accept and continue</button>
        </div>
      ) : <div className="text-sm"><LinkedinConnect state={st.connect ?? null} onChange={() => void load()} /></div>}
      {msg && <p className="text-sm text-[#555] mt-3" role="status">{msg}</p>}
    </div>
  )
  return (
    <div id="linkedin-reading" className="card p-6 mb-4 scroll-mt-6" data-testid="linkedin-reading">
      <h2 className="font-semibold mb-1">LinkedIn reading</h2>
      <p className="text-[#555] text-sm mb-4">
        dazl Connect reads LinkedIn People pages, profiles and post comments in your browser, one page at a time with a pause between pages,
        up to 40 a day{st.tz ? `, in ${st.tz} time` : ''}. It only reads. It stops for a day if LinkedIn shows a security check or asks it to slow down.
      </p>
      <p className="text-sm mb-3">
        {st.paused ? 'Paused.' : st.stopped_until ? `Stopped by LinkedIn until ${new Date(st.stopped_until * 1000).toLocaleString()}.` : 'On.'} {st.read_today} pages read today, {st.queued} waiting.
        {st.today_close_min !== null ? ` Reading until ${hm(st.today_close_min)} tonight.` : ''}
      </p>
      <div className="flex flex-wrap items-center gap-2 mb-3 text-sm">
        <span>Reading hours</span>
        <select className="input" value={open} onChange={e => setOpen(e.target.value)} aria-label="Start">{HOURS.map(h => <option key={h}>{h}</option>)}</select>
        <span>to</span>
        <select className="input" value={close} onChange={e => setClose(e.target.value)} aria-label="End">{[...HOURS.slice(1), '24:00'].map(h => <option key={h}>{h}</option>)}</select>
        <button className="btn-ghost" type="button" onClick={() => act({ action: 'window', open, close })}>Save hours</button>
      </div>
      <div className="flex flex-wrap items-center gap-2 mb-3 text-sm">
        <span>Tonight only, read until</span>
        <select className="input" value={tonight} onChange={e => setTonight(e.target.value)} aria-label="Tonight until">{[...HOURS.slice(1), '24:00'].map(h => <option key={h}>{h}</option>)}</select>
        <button className="btn-ghost" type="button" onClick={() => act({ action: 'tonight', close: tonight })}>Apply tonight</button>
      </div>
      <button className="btn-ghost" type="button" onClick={() => act({ action: st.paused ? 'resume' : 'pause' })}>{st.paused ? 'Resume' : 'Pause'}</button>
      <div className="text-sm mt-4"><LinkedinConnect state={st.connect ?? null} onChange={() => void load()} /></div>
      {msg && <p className="text-sm text-[#555] mt-3" role="status">{msg}</p>}
    </div>
  )
}
