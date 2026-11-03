'use client'
import { useEffect, useState } from 'react'

interface Session { public_id: string; created_at: number; last_seen_at: number | null; device: string; current: boolean }
const when = (s: number | null) => s ? new Date(s * 1000).toLocaleString() : 'unknown'
const fetchSessions = (): Promise<Session[]> => fetch('/api/auth/sessions').then(r => r.ok ? r.json() : null).then(j => j?.sessions ?? []).catch(() => [])

export default function SessionsPanel() {
  const [rows, setRows] = useState<Session[] | null>(null)
  const [msg, setMsg] = useState('')
  function load() { void fetchSessions().then(setRows) }
  useEffect(load, [])

  async function post(path: string, method: string, body: unknown, done: string) {
    const r = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    setMsg(r.ok ? done : 'Something went wrong')
    load()
  }

  if (!rows) return null
  const others = rows.filter(s => !s.current).length
  return (
    <div className="card p-6 mb-4">
      <h2 className="font-semibold mb-1">Signed-in devices</h2>
      <p className="text-[#555] text-sm mb-3">Every place your account is signed in. Signing a device out takes effect on its next click.</p>
      <ul className="text-sm divide-y divide-[var(--line)] mb-3">
        {rows.map(s => (
          <li key={s.public_id} className="flex items-center justify-between gap-3 py-2">
            <span className="min-w-0"><span className="font-medium">{s.device}</span>{s.current ? ' (this device)' : ''}<br /><span className="text-[#555]">Signed in {when(s.created_at)}, last active {when(s.last_seen_at)}</span></span>
            {!s.current && <button className="underline underline-offset-2 shrink-0" onClick={() => void post('/api/auth/sessions', 'DELETE', { id: s.public_id }, 'Signed out.')}>Sign out</button>}
          </li>
        ))}
      </ul>
      {others > 0 && <button className="btn-primary" onClick={() => void post('/api/auth/sessions/revoke-all', 'POST', { keep_current: true }, 'Signed out everywhere else.')}>Sign out everywhere else</button>}
      {msg && <p className="text-sm text-[#555] mt-2">{msg}</p>}
    </div>
  )
}
