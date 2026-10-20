'use client'
import { useEffect, useState } from 'react'

interface State { gmail: { email: string; status: string } | null; sender: { sender_name: string; postal_address: string } | null; daily_cap: number; sent_24h: number }

export default function GmailPanel() {
  const [s, setS] = useState<State | null>(null)
  const [name, setName] = useState('')
  const [addr, setAddr] = useState('')
  const [msg, setMsg] = useState('')

  async function load() {
    const r = await fetch('/api/outreach/settings')
    if (!r.ok) return
    const j: State = await r.json()
    setS(j)
    setName(n => n || j.sender?.sender_name || '')
    setAddr(a => a || j.sender?.postal_address || '')
  }
  useEffect(() => {
    void load()
    const q = new URLSearchParams(window.location.search).get('gmail')
    if (q === 'connected') setMsg('Gmail connected.')
    else if (q) setMsg('Gmail was not connected. Try again.')
  }, [])

  async function saveSender(e: React.FormEvent) {
    e.preventDefault()
    const r = await fetch('/api/outreach/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sender_name: name, postal_address: addr }) })
    setMsg(r.ok ? 'Saved.' : (await r.json()).error || 'Could not save')
    void load()
  }
  async function disconnect() {
    await fetch('/api/gmail/disconnect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    void load()
  }

  const field = 'bg-white/10 border border-white/20 rounded-xl px-4 py-2.5 text-white text-sm'
  return (
    <div className="bg-white/5 border border-white/10 rounded-2xl p-6 mb-4">
      <h2 className="font-semibold mb-1">Email sending (Gmail)</h2>
      <p className="text-gray-400 text-sm mb-4">Emails go out from your own Gmail, one at a time, only after you approve each one. dazl can send but cannot read your mail.</p>
      {s?.gmail ? (
        <div className="flex items-center justify-between text-sm mb-4">
          <span>{s.gmail.email} {s.gmail.status === 'active' ? '(connected)' : '(needs reconnecting)'}</span>
          <span className="flex gap-3">
            {s.gmail.status !== 'active' && <a href="/api/gmail/connect" className="text-indigo-400">Reconnect</a>}
            <button onClick={disconnect} className="text-red-400 hover:text-red-300">Disconnect</button>
          </span>
        </div>
      ) : (
        <a href="/api/gmail/connect" className="inline-block bg-indigo-500 hover:bg-indigo-400 px-5 py-2 rounded-xl text-sm font-medium transition mb-4">Connect Gmail</a>
      )}
      <form onSubmit={saveSender} className="flex flex-col gap-3">
        <input className={field} placeholder="Name recipients see (e.g. Pat Smith, Acme Roofing)" value={name} maxLength={100} onChange={e => setName(e.target.value)} />
        <input className={field} placeholder="Mailing address (required in every email by law)" value={addr} maxLength={300} onChange={e => setAddr(e.target.value)} />
        <button className="bg-white/10 hover:bg-white/20 px-5 py-2 rounded-xl text-sm transition w-fit">Save sender details</button>
      </form>
      {s && <p className="text-gray-500 text-xs mt-3">Sent in the last 24 hours: {s.sent_24h} of {s.daily_cap}.</p>}
      {msg && <p className="text-sm text-gray-400 mt-2">{msg}</p>}
    </div>
  )
}
