'use client'
import { useEffect, useState } from 'react'
import IndexingPanel from './indexing-panel'

interface Check { id: string; label: string; ok: boolean; value: string; hint: string }
interface Audit { id: string; domain: string; results: { domain: string; fetched_at: number; checks: Check[] }; created_at: number }

export default function SeoClient() {
  const [domain, setDomain] = useState('')
  const [audits, setAudits] = useState<Audit[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    void fetch('/api/seo/audit').then(r => r.ok ? r.json() : null).then(j => { if (j) setAudits(j.audits) }).catch(() => {})
    void fetch('/api/settings/profile').then(r => r.ok ? r.json() : null).then(j => { if (j?.website) setDomain(String(j.website).replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '')) }).catch(() => {})
  }, [])

  async function run(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setMsg('')
    const r = await fetch('/api/seo/audit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain }) })
    const j = await r.json().catch(() => ({}))
    setBusy(false)
    if (!r.ok) { setMsg(j.error || 'Audit failed'); return }
    setAudits(a => [{ id: `new-${Date.now()}`, domain: j.domain, results: j, created_at: j.fetched_at }, ...a].slice(0, 10))
  }

  const input = 'bg-white border border-black/20 rounded px-4 py-2.5 text-[#111] text-sm'
  return (
    <div className="p-8 max-w-3xl">
      <h1 className="text-2xl font-bold tracking-tight mb-1">SEO</h1>
      <p className="text-[#555] text-sm mb-6">Indexing audit: the basics a search engine needs to find and list your site. The page is fetched directly - nothing is sent to a third party.</p>
      <form onSubmit={run} className="flex gap-2 mb-8">
        <input className={`${input} flex-1`} placeholder="yourdomain.com" value={domain} onChange={e => setDomain(e.target.value)} maxLength={253} />
        <button className="btn-primary px-5 py-2 text-sm" disabled={busy || !domain.trim()}>{busy ? 'Auditing...' : 'Run audit'}</button>
      </form>
      {msg && <p className="text-sm text-red-700 mb-4">{msg}</p>}
      <IndexingPanel />
      {audits.map(a => (
        <div key={a.id} className="card p-6 mb-4">
          <div className="flex items-center justify-between mb-3">
            <span className="font-medium text-sm">{a.results.domain}</span>
            <span className="text-xs text-[#888]">{new Date(a.created_at * 1000).toLocaleString()}</span>
          </div>
          <ul className="space-y-2">
            {a.results.checks.map(c => (
              <li key={c.id} className="text-sm">
                <span className={c.ok ? 'text-green-700' : 'text-red-700'}>{c.ok ? '✓' : '✗'}</span>{' '}
                <span className="font-medium">{c.label}</span>{' '}
                <span className="text-[#555]">{c.value}</span>
                {!c.ok && c.hint && <span className="block text-xs text-[#888] mt-0.5 ml-5">{c.hint}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
