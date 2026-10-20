'use client'
import { useEffect, useState } from 'react'

interface Lead { id: string; name: string; company: string; contact: string | null; signal: string; source_url: string; score: number; evidence_excerpt: string | null; event_date: string | null; date_status: string | null; confidence: number | null }

export default function LeadsClient() {
  const [form, setForm] = useState({ business_name: '', industry: '', location: '' })
  const [jobId, setJobId] = useState<string | null>(null)
  const [status, setStatus] = useState<string>('')
  const [leads, setLeads] = useState<Lead[]>([])
  const [error, setError] = useState('')

  const [drafted, setDrafted] = useState<Record<string, string>>({})
  async function draft(leadId: string) {
    const r = await fetch('/api/outreach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lead_id: leadId }) })
    const j = await r.json()
    setDrafted(d => ({ ...d, [leadId]: r.ok ? 'Draft created. Review it in Outreach.' : j.error || 'Could not create the draft' }))
  }

  async function start(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const r = await fetch('/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form) })
    const j = await r.json()
    if (!r.ok) return setError(j.error || 'Could not start the scan')
    setJobId(j.job_id); setStatus('pending'); setLeads([])
  }

  useEffect(() => {
    if (!jobId || status === 'done' || status === 'failed') return
    const t = setInterval(async () => {
      const r = await fetch(`/api/scan/status?job_id=${jobId}`)
      if (!r.ok) return
      const s = await r.json()
      setStatus(s.status)
      if (s.status === 'done') {
        const l = await fetch(`/api/leads?job_id=${jobId}`)
        if (l.ok) setLeads((await l.json()).leads)
      }
    }, 5000)
    return () => clearInterval(t)
  }, [jobId, status])

  const input = 'bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm'
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-1">Leads</h1>
      <p className="text-gray-400 text-sm mb-6">Buyers showing purchase intent, with the signal and source for each.</p>
      <form onSubmit={start} className="flex flex-wrap gap-2 mb-6">
        <input className={input} placeholder="Business name" required maxLength={150} value={form.business_name} onChange={e => setForm({ ...form, business_name: e.target.value })} />
        <input className={input} placeholder="Industry" required maxLength={100} value={form.industry} onChange={e => setForm({ ...form, industry: e.target.value })} />
        <input className={input} placeholder="Location" required maxLength={100} value={form.location} onChange={e => setForm({ ...form, location: e.target.value })} />
        <button className="bg-indigo-500 hover:bg-indigo-400 px-5 py-2 rounded-xl text-sm font-medium transition">Run scan</button>
      </form>
      {error && <p className="text-red-400 text-sm mb-4">{error}</p>}
      {jobId && status !== 'done' && <p className="text-gray-400 text-sm mb-4">Scan {status === 'failed' ? 'failed. Try again.' : `${status}... this can take a few minutes.`}</p>}
      <div className="bg-white/5 border border-white/10 rounded-2xl divide-y divide-white/5">
        {leads.length === 0 ? (
          <p className="p-10 text-center text-gray-500 text-sm">{status === 'done' ? 'The scan finished with no leads.' : 'No leads yet. Run a scan.'}</p>
        ) : leads.map(l => (
          <div key={l.id} className="p-4 text-sm">
            <div className="font-medium">{l.company || l.name} <span className="text-gray-500">score {l.score}</span></div>
            <div className="text-gray-400">{l.signal}</div>
            {l.evidence_excerpt && <blockquote className="text-gray-500 text-xs border-l border-white/10 pl-3 my-1">&ldquo;{l.evidence_excerpt}&rdquo;</blockquote>}
            <span className="text-gray-500 text-xs mr-3">{l.confidence === null ? 'not verified' : `confidence ${l.confidence}`}{l.event_date ? `, ${l.event_date}${l.date_status === 'unverified' ? ' (date not confirmed on page)' : ''}` : ''}</span>
            <a className="text-indigo-400 text-xs" href={l.source_url} target="_blank" rel="noopener noreferrer nofollow">source</a>
            {l.contact && <span className="text-gray-500 text-xs ml-3">{l.contact}</span>}
            {l.contact?.includes('@') && l.confidence !== null && (
              drafted[l.id]
                ? <span className="text-gray-400 text-xs ml-3">{drafted[l.id]}</span>
                : <button onClick={() => draft(l.id)} className="text-xs bg-white/10 hover:bg-white/20 px-2 py-1 rounded ml-3">Draft email</button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
