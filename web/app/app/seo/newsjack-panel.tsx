'use client'
import { useEffect, useState } from 'react'
import { markdownToPlain } from '@/lib/text/plain'

type Nj = { id: string; url: string; title: string | null; draft: string; status: string; created_at: number }

export default function NewsjackPanel() {
  const [items, setItems] = useState<Nj[]>([])
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [copied, setCopied] = useState('')
  // #902: explicit load error + retry, busy always cleared, approve shown only after the server confirms it.
  const [loadErr, setLoadErr] = useState('')
  async function load() {
    try {
      const r = await fetch('/api/seo/newsjack')
      if (!r.ok) { setLoadErr(`Could not load drafts (error ${r.status}).`); return }
      const j = await r.json().catch(() => null)
      if (!j || !Array.isArray(j.newsjacks)) { setLoadErr('Could not load drafts (unexpected response).'); return }
      setItems(j.newsjacks); setLoadErr('')
    } catch { setLoadErr('Could not load drafts. Check your connection.') }
  }
  useEffect(() => { void Promise.resolve().then(load) }, [])
  async function create() {
    setBusy(true); setMsg('')
    try {
      const r = await fetch('/api/seo/newsjack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) })
      const j = await r.json().catch(() => null)
      if (!r.ok) { setMsg(j?.error || `Could not draft (error ${r.status}).`); return }
      // A 2xx only counts once the body is the draft: otherwise the draft may exist, so keep the URL and point at the list.
      if (!j || typeof j.id !== 'string' || typeof j.draft !== 'string') { setMsg('dazl answered, but the reply could not be read, so the draft may or may not exist. Your link is kept. Reload the list below before trying again.'); void load(); return }
      setUrl('')
    } catch {
      setMsg('Could not reach dazl, so the draft may or may not exist. Check the list below before trying again.')
    } finally { setBusy(false) }
    void load()
  }
  async function approve(id: string) {
    setMsg('')
    try {
      const r = await fetch('/api/seo/newsjack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'approve', id }) })
      if (!r.ok) { const j = await r.json().catch(() => ({})); setMsg(j.error || `Not approved (error ${r.status}). Try again.`) }
    } catch { setMsg('Could not reach dazl, so the approval may not have saved. The list below shows the confirmed state.') }
    void load()
  }
  async function copy(id: string, text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(id); setTimeout(() => setCopied(''), 2000) } catch { setMsg('Copy failed - select the text and copy it by hand.') }
  }
  return (
    <div className="card p-6 mb-8">
      <h2 className="font-semibold mb-1">Newsjacking drafts</h2>
      <p className="text-[#555] text-sm mb-3">Paste a news link, get a draft take on your own AI key. dazl never posts anything - approve the draft, copy it, and publish it yourself in your own Notion or channels.</p>
      <div className="flex gap-2 mb-3">
        <input className="field flex-1" type="url" placeholder="https://news-site.example/big-story" value={url} onChange={e => setUrl(e.target.value)} maxLength={480} />
        <button className="btn-primary text-sm" disabled={busy || !url.trim().startsWith('https://')} onClick={create}>{busy ? 'Reading + drafting...' : 'Draft take'}</button>
      </div>
      {msg && <p role="alert" className="text-sm text-red-700 mb-2" data-testid="newsjack-error">{msg}</p>}
      {loadErr && <p role="alert" className="text-sm text-red-700 mb-2" data-testid="newsjack-load-error">{loadErr} <button className="underline" onClick={() => void load()}>Try again</button></p>}
      {items.map(n => (
        <details key={n.id} className="text-sm mb-2" open={n.status === 'draft'}>
          <summary className="cursor-pointer font-medium">
            {n.title || n.url} {n.status === 'approved' ? <span className="text-green-700 text-xs ml-1">approved</span> : <span className="text-[#999] text-xs ml-1">draft</span>}
            <span className="text-[#999] text-xs ml-2">{new Date(n.created_at * 1000).toLocaleDateString()}</span>
          </summary>
          <pre className="whitespace-pre-wrap text-[#333] text-xs mt-2 font-sans">{markdownToPlain(n.draft)}</pre>
          <div className="flex gap-4 mt-2 text-xs">
            {n.status === 'draft' && <button className="underline" onClick={() => approve(n.id)}>Approve</button>}
            {n.status === 'approved' && <button className="underline" onClick={() => copy(n.id, n.draft)}>{copied === n.id ? 'Copied' : 'Copy to clipboard'}</button>}
            <a className="underline text-[#888]" href={n.url} target="_blank" rel="noopener noreferrer">Source</a>
          </div>
        </details>
      ))}
    </div>
  )
}
