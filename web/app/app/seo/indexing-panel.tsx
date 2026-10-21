'use client'
import { useEffect, useState } from 'react'

type State = {
  config: { domain: string; next_run_at: number | null } | null
  keywords: string[]
  results: { keyword: string; indexed: boolean; top_url: string | null }[]
  allowance: { used: number; limit: number }
}

export default function IndexingPanel() {
  const [st, setSt] = useState<State | null>(null)
  const [domain, setDomain] = useState('')
  const [kw, setKw] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  async function load() { const r = await fetch('/api/seo/indexing'); if (r.ok) { const j = await r.json(); setSt(j); if (j.config?.domain) setDomain(j.config.domain) } }
  useEffect(() => { void load() }, [])
  async function act(body: Record<string, unknown>) {
    setBusy(true)
    const r = await fetch('/api/seo/indexing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    setMsg(r.ok ? '' : j.error || 'Something went wrong')
    setKw('')
    setBusy(false)
    void load()
  }
  if (!st) return null
  const resultFor = (k: string) => st.results.find(r => r.keyword === k)
  return (
    <div className="card p-6 mb-8">
      <h2 className="font-semibold mb-1">Weekly indexing checks</h2>
      <p className="text-[#555] text-sm mb-3">Each week dazl searches for your domain against your keywords and records whether you show up. Indicative only - search indexes vary by time and place; a "not found" is a prompt to look, not proof of a problem.</p>
      <div className="flex gap-2 mb-3">
        <input className="field flex-1" placeholder="yourdomain.com" value={domain} onChange={e => setDomain(e.target.value)} maxLength={253} />
        <button className="btn-primary text-sm" disabled={busy || !domain.trim()} onClick={() => act({ action: 'domain', domain: domain.trim() })}>Save domain</button>
      </div>
      {st.config && (
        <>
          <div className="flex gap-2 mb-3">
            <input className="field flex-1" placeholder="a keyword buyers search, e.g. crm for small teams" value={kw} onChange={e => setKw(e.target.value)} maxLength={120} />
            <button className="btn-primary text-sm" disabled={busy || kw.trim().length < 2 || st.keywords.length >= 10} onClick={() => act({ action: 'add', keyword: kw.trim() })}>Add keyword</button>
          </div>
          {st.keywords.length > 0 && (
            <ul className="text-sm space-y-1 mb-3">
              {st.keywords.map(k => {
                const r = resultFor(k)
                return (
                  <li key={k} className="flex items-center justify-between gap-3">
                    <span>{k}</span>
                    <span className="flex items-center gap-3">
                      {r ? (r.indexed ? <span className="text-green-700 text-xs">listed</span> : <span className="text-red-700 text-xs">not found</span>) : <span className="text-[#999] text-xs">not checked yet</span>}
                      <button className="text-xs underline text-[#888]" onClick={() => act({ action: 'remove', keyword: k })}>remove</button>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
          <div className="flex items-center gap-4 text-xs text-[#555]">
            <span>{st.keywords.length}/10 keywords · {st.allowance.used}/{st.allowance.limit} weekly searches used</span>
            <button className="underline" disabled={busy || st.keywords.length === 0} onClick={() => act({ action: 'run' })}>Check now</button>
            {st.config.next_run_at && <span>next automatic check {new Date(st.config.next_run_at * 1000).toLocaleDateString()}</span>}
          </div>
        </>
      )}
      {msg && <p className="text-sm text-red-700 mt-2">{msg}</p>}
    </div>
  )
}
