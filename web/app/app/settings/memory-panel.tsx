'use client'
import { useEffect, useState } from 'react'

interface Memory { icp: string; positioning: string; tone: string; exclusions: string[]; objections: { q: string; a: string }[] }

const lines = (v: string) => v.split('\n').map(x => x.trim()).filter(Boolean)

export default function MemoryPanel() {
  const [m, setM] = useState<Memory | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void fetch('/api/settings/memory').then(r => r.ok ? r.json() : null).then(j => setM(j?.memory ?? { icp: '', positioning: '', tone: '', exclusions: [], objections: [] })).catch(() => setM({ icp: '', positioning: '', tone: '', exclusions: [], objections: [] }))
  }, [])

  async function save() {
    if (!m) return
    setBusy(true); setMsg('')
    const r = await fetch('/api/settings/memory', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(m) })
    const j = await r.json().catch(() => ({}))
    setBusy(false)
    if (!r.ok) { setMsg(j.error || 'Could not save'); return }
    setM(j.memory)
    setMsg('Saved.')
  }

  if (!m) return null
  return (
    <div className="card p-6 mb-4">
      <h2 className="font-semibold mb-1">Memory</h2>
      <p className="text-[#555] text-sm mb-4">What dazl remembers about how you sell. It shapes outreach drafts, follow-ups and lead scoring, on your own AI key (a few hundred extra tokens per call). Exclusions are hard rules: matching companies never reach your leads.</p>
      <label className="block text-xs text-gray-500 mb-1">Who you sell to (ICP)</label>
      <textarea className="field w-full mb-2" rows={2} maxLength={600} value={m.icp} onChange={e => setM({ ...m, icp: e.target.value })} placeholder="e.g. Seed to Series B B2B SaaS, sales-led, 10-200 staff, North America" />
      <label className="block text-xs text-gray-500 mb-1">Your positioning</label>
      <textarea className="field w-full mb-2" rows={2} maxLength={600} value={m.positioning} onChange={e => setM({ ...m, positioning: e.target.value })} placeholder="e.g. We help sales teams find buyers who are already looking, without paid data tools" />
      <label className="block text-xs text-gray-500 mb-1">Tone for drafts</label>
      <input className="field w-full mb-2" maxLength={200} value={m.tone} onChange={e => setM({ ...m, tone: e.target.value })} placeholder="e.g. Direct, plain, no buzzwords" />
      <label className="block text-xs text-gray-500 mb-1">Never sell to (one per line, company or domain)</label>
      <textarea className="field w-full mb-2" rows={2} value={m.exclusions.join('\n')} onChange={e => setM({ ...m, exclusions: lines(e.target.value).slice(0, 20) })} placeholder={"acme.com\nBigco Inc"} />
      <label className="block text-xs text-gray-500 mb-1">Objections and your answers (one per line, question: answer)</label>
      <textarea className="field w-full mb-3" rows={3} value={m.objections.map(o => `${o.q}: ${o.a}`).join('\n')} onChange={e => setM({ ...m, objections: lines(e.target.value).map(l => { const i = l.indexOf(':'); return i > 0 ? { q: l.slice(0, i).trim(), a: l.slice(i + 1).trim() } : null }).filter((o): o is { q: string; a: string } => !!o && !!o.q && !!o.a).slice(0, 10) })} placeholder={"We already use a data provider: dazl only surfaces buyers showing a live signal, not static lists"} />
      <button onClick={() => void save()} disabled={busy} className="btn-primary">{busy ? 'Saving...' : 'Save memory'}</button>
      {msg && <p className="text-sm text-[#555] mt-3">{msg}</p>}
    </div>
  )
}
