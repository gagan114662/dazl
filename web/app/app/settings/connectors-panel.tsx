'use client'
import { useEffect, useState } from 'react'

interface Status { connector: string; last4: string; enabled: boolean }
interface Audit { connector: string; lookup: string; status: string; results: number; created_at: number }

export default function ConnectorsPanel() {
  const [list, setList] = useState<Status[]>([])
  const [audit, setAudit] = useState<Audit[]>([])
  const [apiKey, setApiKey] = useState('')
  const [msg, setMsg] = useState('')

  async function load() {
    const r = await fetch('/api/settings/connectors')
    if (r.ok) { const j = await r.json(); setList(j.connectors); setAudit(j.audit) }
  }
  useEffect(() => { void load() }, [])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setMsg('Checking your key...')
    const r = await fetch('/api/settings/connectors', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connector: 'hunter', api_key: apiKey }) })
    const j = await r.json()
    setMsg(r.ok ? 'Hunter connected.' : j.error || 'Could not save the key')
    if (r.ok) { setApiKey(''); void load() }
  }
  async function toggle(enabled: boolean) {
    await fetch('/api/settings/connectors', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connector: 'hunter', enabled }) })
    void load()
  }
  async function remove() {
    await fetch('/api/settings/connectors?connector=hunter', { method: 'DELETE' })
    void load()
  }

  const hunter = list.find(c => c.connector === 'hunter')
  return (
    <div className="card p-6 mb-4">
      <h2 className="font-semibold mb-1">Connectors</h2>
      <p className="text-[#555] text-sm mb-4">Add contact details to verified leads. Each connector uses your own account and key. dazl shows an added field only with the page it came from and the date.</p>
      <div className="text-sm font-medium mb-1">Hunter (email finder)</div>
      <p className="text-[#555] text-sm mb-3">After a scan, dazl sends the company name of up to 10 verified leads to Hunter on your key. Hunter bills your own plan. Nothing else is sent.</p>
      {hunter ? (
        <div className="flex items-center justify-between text-sm mb-3 gap-3">
          <span>Key ending in {hunter.last4}, {hunter.enabled ? 'on' : 'off'}</span>
          <span className="flex gap-4">
            <button onClick={() => toggle(!hunter.enabled)} className="text-[#111] underline underline-offset-2">{hunter.enabled ? 'Turn off' : 'Turn on'}</button>
            <button onClick={remove} className="text-[#111] underline underline-offset-2">Remove</button>
          </span>
        </div>
      ) : (
        <form onSubmit={save} className="flex flex-col gap-3" autoComplete="off">
          <input className="field" type="password" autoComplete="off" placeholder="Paste your Hunter API key" value={apiKey} onChange={e => setApiKey(e.target.value)} />
          <button className="btn-primary w-fit">Connect Hunter</button>
          {msg && <p className="text-sm text-[#555]">{msg}</p>}
        </form>
      )}
      {audit.length > 0 && (
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-[#555]">Recent lookups ({audit.length})</summary>
          <ul className="mt-2 text-[#555] text-xs space-y-1">
            {audit.map((a, i) => <li key={i}>{new Date(a.created_at * 1000).toLocaleString()}: {a.connector} for &ldquo;{a.lookup}&rdquo;, {a.status}, {a.results} found</li>)}
          </ul>
        </details>
      )}
    </div>
  )
}
