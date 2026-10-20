'use client'
import { useEffect, useState } from 'react'

interface Lead { id: string; name: string; company: string; contact: string | null; signal: string; source_url: string; score: number; evidence_excerpt: string | null; event_date: string | null; date_status: string | null; confidence: number | null; review_reason: string | null }
interface Quality { candidates: number; passed: number | null; needs_review: number | null; dropped: number | null; drop_reasons: Record<string, number> }

const REASON: Record<string, string> = {
  excerpt_not_on_page: 'quote not on the page', no_excerpt: 'no usable quote', entity_mismatch: 'company not named in the quote', no_company: 'no company name',
  stale: 'older than 12 months', date_conflict: 'page shows an older date', future_date: 'date in the future', bad_date: 'unreadable date', low_confidence: 'low confidence',
  contradicted: 'page contradicts the claim', claim_unclear: 'page does not clearly support the claim', page_unreachable: 'page could not be loaded', page_not_found: 'page no longer exists',
  url_refused: 'unsafe or unsupported address', duplicate: 'duplicate company',
}
const REVIEW: Record<string, string> = { blocked_by_site: 'The site blocked our check', needs_javascript: 'The page needs JavaScript to show its content' }

export default function LeadsClient() {
  const [form, setForm] = useState({ business_name: '', industry: '', location: '' })
  const [jobId, setJobId] = useState<string | null>(null)
  const [status, setStatus] = useState<string>('')
  const [leads, setLeads] = useState<Lead[]>([])
  const [error, setError] = useState('')
  const [quality, setQuality] = useState<Quality | null>(null)

  async function start(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const r = await fetch('/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form) })
    const j = await r.json()
    if (!r.ok) return setError(j.error || 'Could not start the scan')
    setJobId(j.job_id); setStatus('pending'); setLeads([]); setQuality(null)
  }

  useEffect(() => {
    if (!jobId || status === 'done' || status === 'failed') return
    const t = setInterval(async () => {
      const r = await fetch(`/api/scan/status?job_id=${jobId}`)
      if (!r.ok) return
      const s = await r.json()
      setStatus(s.status)
      setQuality(s.quality ?? null)
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
      {quality && status === 'done' && (
        <p className="text-gray-400 text-sm mb-4">
          {quality.candidates} found: {quality.passed ?? 0} verified, {quality.needs_review ?? 0} need your review, {quality.dropped ?? 0} dropped
          {Object.keys(quality.drop_reasons).length > 0 && <> ({Object.entries(quality.drop_reasons).map(([k, n]) => `${n} ${REASON[k] ?? k}`).join(', ')})</>}.
        </p>
      )}
      <div className="bg-white/5 border border-white/10 rounded-2xl divide-y divide-white/5">
        {leads.filter(l => !l.review_reason).length === 0 ? (
          <p className="p-10 text-center text-gray-500 text-sm">{status === 'done' ? 'The scan finished with no leads.' : 'No leads yet. Run a scan.'}</p>
        ) : leads.filter(l => !l.review_reason).map(l => (
          <div key={l.id} className="p-4 text-sm">
            <div className="font-medium">{l.company || l.name} <span className="text-gray-500">score {l.score}</span></div>
            <div className="text-gray-400">{l.signal}</div>
            {l.evidence_excerpt && <blockquote className="text-gray-500 text-xs border-l border-white/10 pl-3 my-1">&ldquo;{l.evidence_excerpt}&rdquo;</blockquote>}
            <span className="text-gray-500 text-xs mr-3">{l.confidence === null ? 'not verified' : `confidence ${l.confidence}`}{l.event_date ? `, ${l.event_date}${l.date_status === 'unverified' ? ' (date not confirmed on page)' : ''}` : ''}</span>
            <a className="text-indigo-400 text-xs" href={l.source_url} target="_blank" rel="noopener noreferrer nofollow">source</a>
            {l.contact && <span className="text-gray-500 text-xs ml-3">{l.contact}</span>}
          </div>
        ))}
      </div>
      {leads.some(l => l.review_reason) && (
        <>
          <h2 className="text-sm font-semibold mt-8 mb-2">Needs your review</h2>
          <p className="text-gray-500 text-xs mb-3">dazl could not read these pages, so nothing is confirmed and they will not be emailed. Open the source and check them yourself.</p>
          <div className="bg-white/5 border border-white/10 rounded-2xl divide-y divide-white/5">
            {leads.filter(l => l.review_reason).map(l => (
              <div key={l.id} className="p-4 text-sm">
                <div className="font-medium">{l.company || l.name}</div>
                <div className="text-gray-400">{l.signal}</div>
                <span className="text-yellow-500 text-xs mr-3">{REVIEW[l.review_reason ?? ''] ?? 'Not verified'}</span>
                <a className="text-indigo-400 text-xs" href={l.source_url} target="_blank" rel="noopener noreferrer nofollow">source</a>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
