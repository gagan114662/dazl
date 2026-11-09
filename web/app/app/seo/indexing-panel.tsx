'use client'
import { useEffect, useState } from 'react'

type State = {
  config: { domain: string; next_run_at: number | null } | null
  keywords: string[]
  results: { keyword: string; indexed: boolean; top_url: string | null; domain: string; checked_at: number }[]
  allowance: { used: number; limit: number }
}

export default function IndexingPanel() {
  const [st, setSt] = useState<State | null>(null)
  const [domain, setDomain] = useState('')
  const [kw, setKw] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  // #902: the panel no longer disappears when its read fails; it says so with a retry. Actions always clear busy,
  // keep the typed keyword unless the server confirmed it, and distinguish HTTP errors from network failure.
  const [loadErr, setLoadErr] = useState('')
  async function load() {
    try {
      const r = await fetch('/api/seo/indexing')
      if (!r.ok) { setLoadErr(`Could not load indexing checks (error ${r.status}).`); return }
      const j = await r.json().catch(() => null)
      if (!j || !Array.isArray(j.keywords) || !Array.isArray(j.results) || !j.allowance) { setLoadErr('Could not load indexing checks (unexpected response).'); return }
      setSt(j); setLoadErr('')
      if (j.config?.domain) setDomain(d => d || j.config.domain)
    } catch { setLoadErr('Could not load indexing checks. Check your connection.') }
  }
  useEffect(() => { void Promise.resolve().then(load) }, [])
  async function act(body: Record<string, unknown>) {
    setBusy(true); setMsg('')
    try {
      const r = await fetch('/api/seo/indexing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { setMsg(j.error || `Not saved (error ${r.status}). Try again.`); return }
      if (body.action === 'add') setKw('')
    } catch {
      setMsg('Could not reach dazl, so this may not have saved. The list shows the confirmed state.')
    } finally { setBusy(false) }
    void load()
  }
  const errLine = loadErr ? <p role="alert" className="text-sm text-red-700 mt-2" data-testid="indexing-load-error">{loadErr} <button className="underline" onClick={() => void load()}>Try again</button></p> : null
  if (!st) return loadErr ? <div className="card p-6 mb-8"><h2 className="font-semibold mb-1">Weekly indexing checks</h2>{errLine}</div> : null
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
                      {r ? <span className="text-xs" title={`checked ${r.domain} on ${new Date(r.checked_at * 1000).toLocaleString()}`}>{r.indexed ? <span className="text-green-700">listed</span> : <span className="text-red-700">not found</span>} <span className="text-[#999]">· {new Date(r.checked_at * 1000).toLocaleDateString()}</span> <span className="sr-only">(checked {r.domain} on {new Date(r.checked_at * 1000).toLocaleString()})</span></span> : <span className="text-[#999] text-xs">not checked yet</span>}
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
      {msg && <p role="alert" className="text-sm text-red-700 mt-2" data-testid="indexing-error">{msg}</p>}
      {errLine}
    </div>
  )
}
