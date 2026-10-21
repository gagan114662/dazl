'use client'
import { useEffect, useState } from 'react'

type Nj = { id: string; url: string; title: string | null; draft: string; status: string; created_at: number }

export default function NewsjackPanel() {
  const [items, setItems] = useState<Nj[]>([])
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [copied, setCopied] = useState('')
  async function load() { const r = await fetch('/api/seo/newsjack'); if (r.ok) setItems((await r.json()).newsjacks) }
  useEffect(() => { void load() }, [])
  async function create() {
    setBusy(true); setMsg('')
    const r = await fetch('/api/seo/newsjack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) })
    const j = await r.json().catch(() => ({}))
    setBusy(false)
    if (!r.ok) { setMsg(j.error || 'Could not draft'); return }
    setUrl('')
    void load()
  }
  async function approve(id: string) {
    await fetch('/api/seo/newsjack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'approve', id }) })
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
      {msg && <p className="text-sm text-red-700 mb-2">{msg}</p>}
      {items.map(n => (
        <details key={n.id} className="text-sm mb-2" open={n.status === 'draft'}>
          <summary className="cursor-pointer font-medium">
            {n.title || n.url} {n.status === 'approved' ? <span className="text-green-700 text-xs ml-1">approved</span> : <span className="text-[#999] text-xs ml-1">draft</span>}
            <span className="text-[#999] text-xs ml-2">{new Date(n.created_at * 1000).toLocaleDateString()}</span>
          </summary>
          <pre className="whitespace-pre-wrap text-[#333] text-xs mt-2 font-sans">{n.draft}</pre>
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
