'use client'
import { useEffect, useState } from 'react'

interface Lead { id: string; name: string; company: string; contact: string | null; signal: string; source_url: string; score: number; evidence_excerpt: string | null; event_date: string | null; date_status: string | null; confidence: number | null; review_reason: string | null; company_domain: string | null; fit: number | null; intent: number | null; action: number | null; why: string | null; signals: string | null; icp_match: string | null; enrichments?: { connector: string; kind: string; value: string; label: string | null; confidence: number | null; source_url: string; source_date: string }[] }
interface Icp { summary: string; who: string[]; industries: string[]; sizes: string[]; where: string[]; signals: string[]; exclude: string[] }
interface Quality { candidates: number; passed: number | null; needs_review: number | null; dropped: number | null; drop_reasons: Record<string, number> }

// Leads written by other workers can carry anything in signals; never let a bad value crash the page.
function parseSignals(v: string | null): string[] {
  if (!v) return []
  try { const p = JSON.parse(v); return Array.isArray(p) ? p.filter(x => typeof x === 'string') : [] } catch { return [] }
}

const REASON: Record<string, string> = {
  excerpt_not_on_page: 'quote not on the page', no_excerpt: 'no usable quote', entity_mismatch: 'company not named in the quote', no_company: 'no company name',
  stale: 'older than 12 months', date_conflict: 'page shows an older date', future_date: 'date in the future', bad_date: 'unreadable date', low_confidence: 'low confidence',
  contradicted: 'page contradicts the claim', claim_unclear: 'page does not clearly support the claim', page_unreachable: 'page could not be loaded', page_not_found: 'page no longer exists',
  source_cap: 'over the 3-per-page cap',
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
  const [leadsSoFar, setLeadsSoFar] = useState(0)
  const [leads, setLeads] = useState<Lead[]>([])
  const [error, setError] = useState('')
  const [quality, setQuality] = useState<Quality | null>(null)
  const [jobError, setJobError] = useState('')
  const [useGithub, setUseGithub] = useState(false)
  const [useYoutube, setUseYoutube] = useState(false)
  const [useV2ex, setUseV2ex] = useState(false)
  const [feedText, setFeedText] = useState('')
  const [pageText, setPageText] = useState('')

  const lines = (v: string) => v.split('\n').map(x => x.trim()).filter(Boolean)

  const [drafted, setDrafted] = useState<Record<string, string>>({})
  const [pushed, setPushed] = useState<Record<string, string>>({})
  const [crmOn, setCrmOn] = useState(false)
  const [hiddenCount, setHiddenCount] = useState(0)
  const [showHidden, setShowHidden] = useState(false)
  async function pushCrm(leadId: string) {
    const r = await fetch('/api/crm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'push', lead_id: leadId }) })
    const j = await r.json().catch(() => ({}))
    setPushed(d => ({ ...d, [leadId]: r.ok ? (j.message || 'Pushed to CRM') : j.error || 'Push failed' }))
  }
  async function makeDraft(leadId: string) {
    const r = await fetch('/api/outreach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lead_id: leadId }) })
    const j = await r.json()
    setDrafted(d => ({ ...d, [leadId]: r.ok ? 'Draft created. Review it in Outreach.' : j.error || 'Could not create the draft' }))
  }

  async function preview(e: React.FormEvent) {
    e.preventDefault()
    setError(''); setDraft(null); setBusy(true)
    const r = await fetch('/api/scan/icp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) })
    const j = await r.json().catch(() => ({}))
    setBusy(false)
    if (!r.ok) return setError(j.error === 'no_api_key' ? 'Add your AI key in Settings first.' : j.error === 'key_rejected' ? 'Your AI key was rejected. Check it in Settings.' : j.error === 'trial_key_invalid' ? 'The scan service is having trouble right now. Try again later.' : j.error || 'Could not build the profile')
    setDraft(j.icp)
    setDraftNote(j.inferred ? 'dazl worked this out from your request. Edit anything that is off, then run the scan.' : 'dazl could not infer more, so it will use your words as they are. Add detail below if you like.')
  }

  const [advReady, setAdvReady] = useState<string[]>([])
  const [advPick, setAdvPick] = useState<string[]>([])
  useEffect(() => { void fetch('/api/settings/advanced').then(r => r.ok ? r.json() : null).then(j => { if (j?.available) setAdvReady(j.platforms.filter((p: { consent: boolean; connected: boolean; enabled: boolean }) => p.consent && p.connected && p.enabled).map((p: { platform: string }) => p.platform)) }).catch(() => {}) }, [])

  async function run(withIcp: Icp | null) {
    setError('')
    const r = await fetch('/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, ...(withIcp ? { icp: withIcp } : {}), ...(useGithub || useYoutube || useV2ex || feedText.trim() || pageText.trim() || advPick.length ? { sources: { adapters: [...(useGithub ? ['github'] : []), ...(useYoutube ? ['youtube'] : []), ...(useV2ex ? ['v2ex'] : []), ...(feedText.trim() ? ['rss'] : []), ...(pageText.trim() ? ['web'] : [])], feeds: lines(feedText), pages: lines(pageText), advanced: advPick } } : {}) }) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) return setError(j.error === 'no_api_key' ? 'Add your AI key in Settings first. A scan needs it.' : j.error === 'trial_exhausted' ? 'Your 3 free scans are used up. Add your own AI key in Settings to keep scanning.' : j.error === 'quota_exceeded' ? 'You have used this month\'s scans. Upgrade in Settings.' : j.error || 'Could not start the scan')
    setJobId(j.job_id); setStatus('pending'); setLeads([]); setQuality(null); setIcp(null); setDraft(null); setLeadsSoFar(0)
  }

  useEffect(() => {
    if (!jobId || status === 'done' || status === 'failed') return
    const t = setInterval(async () => {
      const r = await fetch(`/api/scan/status?job_id=${jobId}`)
      if (!r.ok) return
      const s = await r.json()
      setStatus(s.status); setJobError(s.error ?? ''); setLeadsSoFar(s.lead_count ?? 0)
      setQuality(s.quality ?? null)
      if (s.icp) setIcp({ icp: s.icp, source: s.icp_source })
    }, 5000)
    return () => clearInterval(t)
  }, [jobId, status])

  const loadLeads = async () => {
    if (!jobId) return
    const l = await fetch(`/api/leads?job_id=${jobId}${showHidden ? '&all=1' : ''}`)
    if (l.ok) { const j = await l.json(); setLeads(j.leads); setHiddenCount(j.hidden_count ?? 0) }
  }
  useEffect(() => { if (status === 'done') void loadLeads() }, [jobId, status, showHidden])
  useEffect(() => { fetch('/api/crm').then(r => r.ok ? r.json() : null).then(j => setCrmOn(!!j?.configured)).catch(() => {}) }, [])
  // Restore the last profile so a reload never loses it (item: ICP persistence).
  useEffect(() => {
    if (jobId) return
    void fetch('/api/scan/latest').then(r => r.ok ? r.json() : null).then(j => {
      if (!j) return
      if (j.query && !query) setQuery(j.query)
      if (j.icp) setIcp({ icp: j.icp, source: j.icp_source ?? 'user' })
    }).catch(() => {})
  }, [])

  const input = 'field'
  return (
    <div className="p-8">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight mb-1">Leads</h1>
          <p className="text-gray-400 text-sm mb-6">Buyers showing purchase intent, with the signal and source for each.</p>
        </div>
        <a className="text-sm text-gray-300 underline underline-offset-4 hover:text-white" href={jobId ? `/api/leads/export?job_id=${jobId}` : '/api/leads/export'}>Download CSV</a>
      </div>
      <form onSubmit={preview} className="mb-4">
        <textarea className={`${input} w-full`} rows={3} required minLength={3} maxLength={600} value={query} onChange={e => setQuery(e.target.value)}
          placeholder="What are you looking for? e.g. Seed-stage fintech founders in Europe who just hired their first sales rep" />
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-gray-400">More sources (optional)</summary>
          <div className="mt-2 space-y-2">
            <label className="flex items-center gap-2 text-gray-300"><input type="checkbox" checked={useGithub} onChange={e => setUseGithub(e.target.checked)} /> Also search public GitHub repositories</label>
            <label className="flex items-center gap-2 text-gray-300"><input type="checkbox" checked={useYoutube} onChange={e => setUseYoutube(e.target.checked)} /> Also search public YouTube videos</label>
            <label className="flex items-center gap-2 text-gray-300"><input type="checkbox" checked={useV2ex} onChange={e => setUseV2ex(e.target.checked)} /> Also search public V2EX topics</label>
            <label className="block text-xs text-gray-500">Web page URLs to read (https only, one per line, up to 3). Pages are read through Jina Reader, a third-party service: the URLs are sent to it, and it rate limits requests without a key.</label>
            <textarea className={`${input} w-full`} rows={2} value={pageText} onChange={e => setPageText(e.target.value)} placeholder="https://example.com/blog/post" />
            <label className="block text-xs text-gray-500">RSS or Atom feed URLs to include (https only, one per line, up to 5)</label>
            <textarea className={`${input} w-full`} rows={2} value={feedText} onChange={e => setFeedText(e.target.value)} placeholder="https://example.com/news/feed.xml" />
            {advReady.map(p => <label key={p} className="flex items-center gap-2 text-gray-300"><input type="checkbox" checked={advPick.includes(p)} onChange={e => setAdvPick(e.target.checked ? [...advPick, p] : advPick.filter(x => x !== p))} /> Also search {p} with my session (advanced, may risk the account)</label>)}
            <p className="text-xs text-gray-500">Items from these sources are checked against their page like every other lead.</p>
          </div>
        </details>
        <div className="flex gap-2 mt-2">
          <button disabled={busy} className="btn-primary">{busy ? 'Working out your profile...' : 'Find leads'}</button>
          <button type="button" disabled={query.trim().length < 3} onClick={() => run(null)} className="text-gray-400 hover:text-white text-sm px-3">Skip review, just run</button>
        </div>
      </form>
      {draft && (
        <div className="card p-4 mb-6 text-sm">
          <div className="flex items-center justify-between gap-3 mb-3">
            <p className="text-gray-400">{draftNote}</p>
            <button onClick={() => run(draft)} className="btn-primary shrink-0">Run scan with this profile</button>
          </div>
          <label className="block text-xs text-gray-500 mb-1">Who you want</label>
          <textarea className={`${input} w-full mb-2`} rows={2} maxLength={300} value={draft.summary} onChange={e => setDraft({ ...draft, summary: e.target.value })} />
          {([['who', 'Roles or kinds of buyer (one per line)'], ['industries', 'Industries (one per line, empty means any)'], ['sizes', 'Company sizes (one per line, empty means any)'], ['where', 'Where (one per line, empty means anywhere)'], ['signals', 'Buying signals to look for (one per line)'], ['exclude', 'Skip these (one per line)']] as const).map(([k, label]) => (
            <div key={k}>
              <label className="block text-xs text-gray-500 mb-1">{label}</label>
              <textarea className={`${input} w-full mb-2`} rows={2} value={draft[k].join('\n')} onChange={e => setDraft({ ...draft, [k]: lines(e.target.value) })} />
            </div>
          ))}
          <button onClick={() => run(draft)} className="btn-primary">Run scan with this profile</button>
        </div>
      )}
      {icp && !draft && (
        <details className="text-sm text-gray-400 mb-4">
          <summary className="cursor-pointer">Profile used: {icp.icp.summary} <span className="text-gray-600">({icp.source === 'inferred' ? 'worked out by dazl' : icp.source === 'user' ? 'reviewed by you' : 'your words as written'})</span></summary>
          <ul className="mt-2 ml-4 list-disc text-xs">
            {icp.icp.who.length > 0 && <li>Who: {icp.icp.who.join('; ')}</li>}
            {icp.icp.where.length > 0 && <li>Where: {icp.icp.where.join('; ')}</li>}
            {icp.icp.signals.length > 0 && <li>Signals: {icp.icp.signals.join('; ')}</li>}
            {icp.icp.exclude.length > 0 && <li>Skipping: {icp.icp.exclude.join('; ')}</li>}
          </ul>
          <button className="underline text-[#111] text-xs mt-2" onClick={() => { setDraft(icp.icp); setDraftNote('Edit the profile and run again.') }}>Edit and run again</button>
        </details>
      )}
      {error && <p className="text-red-400 text-sm mb-4">{error}</p>}
      {jobId && status !== 'done' && status !== 'failed' && (
        <div className="card p-4 mb-4 flex items-center gap-3">
          <span className="inline-block h-4 w-4 rounded-full border-2 border-gray-500 border-t-white animate-spin" aria-hidden />
          <div className="text-sm">
            <div>Scanning - this can take a few minutes.</div>
            <div className="text-gray-400 text-xs">{leadsSoFar > 0 ? `${leadsSoFar} lead${leadsSoFar === 1 ? '' : 's'} so far` : 'Searching sources...'}</div>
          </div>
        </div>
      )}
      {jobId && status === 'failed' && <p className="text-gray-400 text-sm mb-4">{jobError === 'no_candidates' ? 'No candidates found for that search. Try rephrasing or broadening it - this scan did not count toward your monthly scans.' : jobError === 'trial_key_invalid' ? 'The scan service is having trouble right now. Try again later - this scan did not count toward your free scans.' : 'Scan failed. Try again.'}</p>}
      {quality && status === 'done' && (
        <p className="text-gray-400 text-sm mb-4">
          {quality.candidates} found: {quality.passed ?? 0} verified, {quality.needs_review ?? 0} need your review, {quality.dropped ?? 0} dropped
          {Object.keys(quality.drop_reasons).length > 0 && <> ({Object.entries(quality.drop_reasons).map(([k, n]) => `${n} ${REASON[k] ?? k}`).join(', ')})</>}.
        </p>
      )}
      <div className="card divide-y divide-white/5">
        {leads.filter(l => !l.review_reason).length === 0 ? (
          <p className="p-10 text-center text-gray-500 text-sm">{status === 'done' ? 'The scan finished with no leads.' : 'No leads yet. Run a scan.'}</p>
        ) : leads.filter(l => !l.review_reason).map(l => (
          <div key={l.id} className="p-4 text-sm">
<div className="font-medium">{l.company_domain ? <a className="underline decoration-white/30 hover:decoration-white" href={`https://${l.company_domain}`} target="_blank" rel="noopener noreferrer nofollow">{l.company || l.name}</a> : (l.company || l.name)} <span className="text-gray-500">score {l.score}</span>
              {l.fit != null && <span className="ml-2 text-xs font-normal text-gray-300 border border-white/15 px-1.5 py-0.5">fit {l.fit}/5 · intent {l.intent}/5 · action {l.action}/5</span>}
              {l.fit != null && l.icp_match && (() => {
                let m: { role?: string; industry?: string; size?: string; location?: string; note?: string } | null = null
                try { m = JSON.parse(l.icp_match) } catch { m = null }
                if (!m) return null
                const chip = (label: string, v?: string) => !v ? null : <span key={label} className={`text-[10px] px-1 border ${v === 'match' ? 'text-green-300 border-green-300/30' : v === 'mismatch' ? 'text-red-300 border-red-300/30' : 'text-gray-500 border-white/10'}`} title={m.note || `${label}: ${v}`}>{label}</span>
                return <span className="ml-1 inline-flex gap-0.5 align-middle">{chip('role', m.role)}{chip('industry', m.industry)}{chip('size', m.size)}{chip('location', m.location)}</span>
              })()}
            </div>
            <div className="text-gray-400">{l.signal}</div>
            {l.why && <div className="text-xs text-gray-300 mt-1">Why now: {l.why}</div>}
            {parseSignals(l.signals).length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">{parseSignals(l.signals).map(sg => <span key={sg} className="text-[10px] uppercase tracking-wide text-gray-500 border border-white/10 px-1 py-0.5">{sg.replace(/_/g, ' ')}</span>)}</div>
            )}
            {l.enrichments && l.enrichments.length > 0 && (
              <div className="text-xs mt-1 space-y-0.5">
                {l.enrichments.map(e => (
                  <div key={e.kind + e.value} className="text-gray-400">
                    <span className="text-[#111]">{e.value}</span>{e.label ? ` (${e.label})` : ''} <span className="text-gray-500">{e.connector === 'sitecrawl' ? 'from the company contact page' : e.connector === 'hunter' ? 'via Hunter (earlier)' : `via ${e.connector}`}{e.confidence !== null ? `, ${e.confidence}% confidence` : ''}, seen {e.source_date}</span>{' '}
                    <a className="underline text-[#111]" href={e.source_url} target="_blank" rel="noopener noreferrer nofollow">source</a>
                  </div>
                ))}
              </div>
            )}
            {l.evidence_excerpt && <blockquote className="text-gray-500 text-xs border-l border-white/10 pl-3 my-1">&ldquo;{l.evidence_excerpt}&rdquo;</blockquote>}
            <span className="text-gray-500 text-xs mr-3">{l.confidence === null ? 'not verified' : `confidence ${l.confidence}`}{l.event_date ? `, ${l.event_date}${l.date_status === 'unverified' ? ' (date not confirmed on page)' : ''}` : ''}</span>
            <a className="underline text-[#111] text-xs" href={l.source_url} target="_blank" rel="noopener noreferrer nofollow">source</a>
            {l.contact && <span className="text-gray-500 text-xs ml-3">{l.contact}</span>}
            {l.contact?.includes('@') && l.confidence !== null && (
              drafted[l.id]
                ? <span className="text-gray-400 text-xs ml-3">{drafted[l.id]}</span>
                : <button onClick={() => makeDraft(l.id)} className="font-mono text-xs uppercase border border-black px-2 py-1 ml-3 hover:bg-black hover:text-white">Draft email</button>)}
            {crmOn && (pushed[l.id]
              ? <span className="text-gray-400 text-xs ml-2">{pushed[l.id]}</span>
              : <button onClick={() => pushCrm(l.id)} className="font-mono text-xs uppercase border border-black px-2 py-1 ml-2 hover:bg-black hover:text-white">Push to CRM</button>)}
          </div>
        ))}
      </div>
      {status === 'done' && (hiddenCount > 0 || showHidden) && (
        <button onClick={() => setShowHidden(v => !v)} className="text-gray-500 hover:text-white text-xs mt-2">
          {showHidden ? 'Hide lower-fit leads' : `Show ${hiddenCount} lower-fit lead${hiddenCount === 1 ? '' : 's'} (fit 0-1)`}
        </button>
      )}
      {leads.some(l => l.review_reason) && (
        <>
          <h2 className="text-sm font-semibold mt-8 mb-2">Needs your review</h2>
          <p className="text-gray-500 text-xs mb-3">dazl could not read these pages, so nothing is confirmed and they will not be emailed. Open the source and check them yourself.</p>
          <div className="card divide-y divide-white/5">
            {leads.filter(l => l.review_reason).map(l => (
              <div key={l.id} className="p-4 text-sm">
                <div className="font-medium">{l.company || l.name}</div>
                <div className="text-gray-400">{l.signal}</div>
                <span className="text-yellow-500 text-xs mr-3">{REVIEW[l.review_reason ?? ''] ?? 'Not verified'}</span>
                <a className="underline text-[#111] text-xs" href={l.source_url} target="_blank" rel="noopener noreferrer nofollow">source</a>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
