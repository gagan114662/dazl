'use client'
import { useEffect, useState } from 'react'

interface Req { id: string; status: string; requested_at: number; decided_at: number | null; note: string | null }
interface S { pending: Req | null; last: Req | null; exports: number; confirm_phrase: string }
const when = (s: number) => new Date(s * 1000).toLocaleString()

// Your data (issue #359): download everything dazl holds for this account, or ask for the account to be deleted.
// Asking records the request only; nothing is deleted until an operator carries it out, and it can be withdrawn.
export default function DataPanel() {
  const [st, setSt] = useState<S | null>(null)
  const [form, setForm] = useState({ confirm: '', email: '', password: '' })
  const [msg, setMsg] = useState('')
  async function load() { const r = await fetch('/api/settings/data'); if (r.ok) setSt(await r.json()) }
  useEffect(() => { void load() }, [])
  if (!st) return null
  async function ask(e: React.FormEvent) {
    e.preventDefault(); setMsg('')
    const r = await fetch('/api/settings/data/deletion', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form) })
    const j = await r.json(); if (!r.ok) setMsg(j.error || 'Something went wrong'); else setForm({ confirm: '', email: '', password: '' })
    void load()
  }
  async function withdraw() { await fetch('/api/settings/data/deletion', { method: 'DELETE' }); void load() }
  return (
    <div className="card p-6 mb-4" data-testid="data-panel">
      <h2 className="font-semibold mb-1">Your data</h2>
      <p className="text-[#555] text-sm mb-3">Download a copy of everything dazl stores for this account: scans, leads, drafts, settings and history. Keys and passwords are left out.</p>
      <a href="/api/settings/data/export" className="btn-primary w-fit inline-block mb-5">Download my data</a>
      {st.pending ? (
        <div className="text-sm" data-testid="deletion-pending">
          <p className="mb-2">You asked for this account to be deleted on {when(st.pending.requested_at)}. Nothing has been deleted yet: the request waits for an operator, who will delete the account and its data. You can still withdraw it.</p>
          <button className="underline underline-offset-2" onClick={withdraw}>Withdraw the request</button>
        </div>
      ) : (
        <form onSubmit={ask} className="flex flex-col gap-2 text-sm" autoComplete="off">
          <p className="text-[#555]">Delete the account: ask for this account and its data to be deleted. This sends a request; it does not delete anything by itself.{st.last?.status === 'refused' ? ` Your last request was declined${st.last.note ? `: ${st.last.note}` : ''}.` : ''}</p>
          <input className="field" placeholder={`Type: ${st.confirm_phrase}`} value={form.confirm} onChange={e => setForm({ ...form, confirm: e.target.value })} />
          <input className="field" type="email" placeholder="Your account email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
          <input className="field" type="password" autoComplete="current-password" placeholder="Your password (not needed for Google sign-in)" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />
          <button className="btn-primary w-fit">Ask to delete my account</button>
        </form>
      )}
      {msg && <p className="text-sm text-[#555] mt-3" role="alert">{msg}</p>}
    </div>
  )
}
