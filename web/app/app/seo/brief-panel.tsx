'use client'
import { useEffect, useState } from 'react'
import { markdownToPlain } from '@/lib/text/plain'

type Brief = { id: string; topic: string; brief: string; created_at: number }

export default function BriefPanel() {
  const [briefs, setBriefs] = useState<Brief[]>([])
  const [topic, setTopic] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  // #902: the saved-briefs read has a visible error + retry; the draft action always clears busy (finally), keeps the
  // typed topic on failure, and tells an HTTP error apart from a network failure (whose outcome is unknown).
  const [loadErr, setLoadErr] = useState('')
  async function load() {
    try {
      const r = await fetch('/api/seo/brief')
      if (!r.ok) { setLoadErr(`Could not load saved briefs (error ${r.status}).`); return }
      const j = await r.json().catch(() => null)
      if (!j || !Array.isArray(j.briefs)) { setLoadErr('Could not load saved briefs (unexpected response).'); return }
      setBriefs(j.briefs); setLoadErr('')
    } catch { setLoadErr('Could not load saved briefs. Check your connection.') }
  }
  useEffect(() => { void Promise.resolve().then(load) }, [])
  async function run() {
    setBusy(true); setMsg('')
    try {
      const r = await fetch('/api/seo/brief', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic }) })
      const j = await r.json().catch(() => null)
      if (!r.ok) { setMsg(j?.error || `Could not draft the brief (error ${r.status}).`); return }
      if (!j || typeof j.id !== 'string' || typeof j.brief !== 'string') { setMsg('The brief may have been drafted, but the reply was unreadable. Reload saved briefs before trying again.'); return }
      setBriefs(b => [j as Brief, ...b].slice(0, 10))
      setTopic('')
    } catch {
      setMsg('Could not reach dazl, so the brief may or may not have been drafted. Reload saved briefs before trying again.')
    } finally { setBusy(false) }
  }
  return (
    <div className="card p-6 mb-8">
      <h2 className="font-semibold mb-1">Content brief</h2>
      <p className="text-[#555] text-sm mb-3">A blog-post brief for a topic your buyers search. Uses your AI key - one call on your own account, never ours.</p>
      <div className="flex gap-2 mb-3">
        <input className="field flex-1" placeholder="e.g. how to find b2b leads without cold email" value={topic} onChange={e => setTopic(e.target.value)} maxLength={300} />
        <button className="btn-primary text-sm" disabled={busy || topic.trim().length < 3} onClick={run}>{busy ? 'Drafting...' : 'Draft brief'}</button>
      </div>
      {msg && <p role="alert" className="text-sm text-red-700 mb-2" data-testid="brief-error">{msg}</p>}
      {loadErr && <p role="alert" className="text-sm text-red-700 mb-2" data-testid="brief-load-error">{loadErr} <button className="underline" onClick={() => void load()}>Reload saved briefs</button></p>}
      {briefs.map(b => (
        <details key={b.id} className="text-sm mb-2">
          <summary className="cursor-pointer font-medium">{b.topic} <span className="text-[#999] text-xs">{new Date(b.created_at * 1000).toLocaleDateString()}</span></summary>
          <pre className="whitespace-pre-wrap text-[#333] text-xs mt-2 font-sans">{markdownToPlain(b.brief)}</pre>
        </details>
      ))}
    </div>
  )
}
