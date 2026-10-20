'use client'
import { useEffect, useState } from 'react'

interface Lead { id: string; name: string; company: string; contact: string | null; signal: string; source_url: string; score: number; evidence_excerpt: string | null; event_date: string | null; date_status: string | null; confidence: number | null; review_reason: string | null }
interface Icp { summary: string; who: string[]; where: string[]; signals: string[]; exclude: string[] }
interface Quality { candidates: number; passed: number | null; needs_review: number | null; dropped: number | null; drop_reasons: Record<string, number> }

const REASON: Record<string, string> = {
  excerpt_not_on_page: 'quote not on the page', no_excerpt: 'no usable quote', entity_mismatch: 'company not named in the quote', no_company: 'no company name',
  stale: 'older than 12 months', date_conflict: 'page shows an older date', future_date: 'date in the future', bad_date: 'unreadable date', low_confidence: 'low confidence',
  contradicted: 'page contradicts the claim', claim_unclear: 'page does not clearly support the claim', page_unreachable: 'page could not be loaded', page_not_found: 'page no longer exists',
  url_refused: 'unsafe or unsupported address', duplicate: 'duplicate company',
}
const REVIEW: Record<string, string> = { blocked_by_site: 'The site blocked our check', needs_javascript: 'The page needs JavaScript to show its content' }

export default function LeadsClient() {
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<Icp | null>(null)
  const [draftNote, setDraftNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [icp, setIcp] = useState<{ icp: Icp; source: string } | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [status, setStatus] = useState<string>('')
  const [leads, setLeads] = useState<Lead[]>([])
  const [error, setError] = useState('')
  const [quality, setQuality] = useState<Quality | null>(null)

  const lines = (v: string) => v.split('\n').map(x => x.trim()).filter(Boolean)

  async function preview(e: React.FormEvent) {
    e.preventDefault()
    setError(''); setDraft(null); setBusy(true)
    const r = await fetch('/api/scan/icp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) })
    const j = await r.json().catch(() => ({}))
    setBusy(false)
    if (!r.ok) return setError(j.error === 'no_api_key' ? 'Add your AI key in Settings first.' : j.error === 'key_rejected' ? 'Your AI key was rejected. Check it in Settings.' : j.error || 'Could not build the profile')
    setDraft(j.icp)
    setDraftNote(j.inferred ? 'dazl worked this out from your request. Edit anything that is off, then run the scan.' : 'dazl could not infer more, so it will use your words as they are. Add detail below if you like.')
  }

  async function run(withIcp: Icp | null) {
    setError('')
    const r = await fetch('/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, ...(withIcp ? { icp: withIcp } : {}) }) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) return setError(j.error === 'quota_exceeded' ? 'You have used this month\'s scans. Upgrade in Settings.' : j.error || 'Could not start the scan')
    setJobId(j.job_id); setStatus('pending'); setLeads([]); setQuality(null); setIcp(null); setDraft(null)
  }

  useEffect(() => {
    if (!jobId || status === 'done' || status === 'failed') return
    const t = setInterval(async () => {
      const r = await fetch(`/api/scan/status?job_id=${jobId}`)
      if (!r.ok) return
      const s = await r.json()
      setStatus(s.status)
      setQuality(s.quality ?? null)
      if (s.icp) setIcp({ icp: s.icp, source: s.icp_source })
      if (s.status === 'done') {
        const l = await fetch(`/api/leads?job_id=${jobId}`)
        if (l.ok) setLeads((await l.json()).leads)
      }
    }, 5000)
    return () => clearInterval(t)
  }, [jobId, status])

  const input = 'field'
  return (
    <div className="p-8">
      <h1 className="text-2xl font-semibold tracking-tight mb-1">Leads</h1>
      <p className="text-[#555] text-sm mb-6">Buyers showing purchase intent, with the signal and source for each.</p>
      <form onSubmit={preview} className="mb-4">
        <textarea className={`${input} w-full`} rows={3} required minLength={3} maxLength={600} value={query} onChange={e => setQuery(e.target.value)}
          placeholder="What are you looking for? e.g. Seed-stage fintech founders in Europe who just hired their first sales rep" />
        <div className="flex gap-2 mt-2">
          <button disabled={busy} className="btn-primary">{busy ? 'Working out your profile...' : 'Find leads'}</button>
          <button type="button" disabled={query.trim().length < 3} onClick={() => run(null)} className="text-[#555] hover:text-[#111] text-sm px-3">Skip review, just run</button>
        </div>
      </form>
      {draft && (
        <div className="card p-4 mb-6 text-sm">
          <p className="text-[#555] mb-3">{draftNote}</p>
          <label className="block text-xs text-[#666] mb-1">Who you want</label>
          <textarea className={`${input} w-full mb-2`} rows={2} maxLength={300} value={draft.summary} onChange={e => setDraft({ ...draft, summary: e.target.value })} />
          {([['who', 'Roles or kinds of buyer (one per line)'], ['where', 'Where (one per line, empty means anywhere)'], ['signals', 'Buying signals to look for (one per line)'], ['exclude', 'Skip these (one per line)']] as const).map(([k, label]) => (
            <div key={k}>
              <label className="block text-xs text-[#666] mb-1">{label}</label>
              <textarea className={`${input} w-full mb-2`} rows={2} value={draft[k].join('\n')} onChange={e => setDraft({ ...draft, [k]: lines(e.target.value) })} />
            </div>
          ))}
          <button onClick={() => run(draft)} className="btn-primary">Run scan with this profile</button>
        </div>
      )}
      {icp && !draft && (
        <details className="text-sm text-[#555] mb-4">
          <summary className="cursor-pointer">Profile used: {icp.icp.summary} <span className="text-[#6b6b6b]">({icp.source === 'inferred' ? 'worked out by dazl' : icp.source === 'user' ? 'reviewed by you' : 'your words as written'})</span></summary>
          <ul className="mt-2 ml-4 list-disc text-xs">
            {icp.icp.who.length > 0 && <li>Who: {icp.icp.who.join('; ')}</li>}
            {icp.icp.where.length > 0 && <li>Where: {icp.icp.where.join('; ')}</li>}
            {icp.icp.signals.length > 0 && <li>Signals: {icp.icp.signals.join('; ')}</li>}
            {icp.icp.exclude.length > 0 && <li>Skipping: {icp.icp.exclude.join('; ')}</li>}
          </ul>
          <button className="text-[#c2410c] text-xs mt-2" onClick={() => { setDraft(icp.icp); setDraftNote('Edit the profile and run again.') }}>Edit and run again</button>
        </details>
      )}
      {error && <p className="text-red-700 text-sm mb-4">{error}</p>}
      {jobId && status !== 'done' && <p className="text-[#555] text-sm mb-4">Scan {status === 'failed' ? 'failed. Try again.' : `${status}... this can take a few minutes.`}</p>}
      {quality && status === 'done' && (
        <p className="text-[#555] text-sm mb-4">
          {quality.candidates} found: {quality.passed ?? 0} verified, {quality.needs_review ?? 0} need your review, {quality.dropped ?? 0} dropped
          {Object.keys(quality.drop_reasons).length > 0 && <> ({Object.entries(quality.drop_reasons).map(([k, n]) => `${n} ${REASON[k] ?? k}`).join(', ')})</>}.
        </p>
      )}
      <div className="card divide-y divide-black/10">
        {leads.filter(l => !l.review_reason).length === 0 ? (
          <p className="p-10 text-center text-[#666] text-sm">{status === 'done' ? 'The scan finished with no leads.' : 'No leads yet. Run a scan.'}</p>
        ) : leads.filter(l => !l.review_reason).map(l => (
          <div key={l.id} className="p-4 text-sm">
            <div className="font-medium">{l.company || l.name} <span className="text-[#666]">score {l.score}</span></div>
            <div className="text-[#555]">{l.signal}</div>
            {l.evidence_excerpt && <blockquote className="text-[#666] text-xs border-l border-black/10 pl-3 my-1">&ldquo;{l.evidence_excerpt}&rdquo;</blockquote>}
            <span className="text-[#666] text-xs mr-3">{l.confidence === null ? 'not verified' : `confidence ${l.confidence}`}{l.event_date ? `, ${l.event_date}${l.date_status === 'unverified' ? ' (date not confirmed on page)' : ''}` : ''}</span>
            <a className="text-[#c2410c] text-xs" href={l.source_url} target="_blank" rel="noopener noreferrer nofollow">source</a>
            {l.contact && <span className="text-[#666] text-xs ml-3">{l.contact}</span>}
          </div>
        ))}
      </div>
      {leads.some(l => l.review_reason) && (
        <>
          <h2 className="text-sm font-semibold mt-8 mb-2">Needs your review</h2>
          <p className="text-[#666] text-xs mb-3">dazl could not read these pages, so nothing is confirmed and they will not be emailed. Open the source and check them yourself.</p>
          <div className="card divide-y divide-black/10">
            {leads.filter(l => l.review_reason).map(l => (
              <div key={l.id} className="p-4 text-sm">
                <div className="font-medium">{l.company || l.name}</div>
                <div className="text-[#555]">{l.signal}</div>
                <span className="text-yellow-500 text-xs mr-3">{REVIEW[l.review_reason ?? ''] ?? 'Not verified'}</span>
                <a className="text-[#c2410c] text-xs" href={l.source_url} target="_blank" rel="noopener noreferrer nofollow">source</a>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
