'use client'
import { KEY_UNREADABLE_COPY, knownErrorCopy } from '@/lib/error-copy'
import { useEffect, useRef, useState } from 'react'
import { emptyLeadsMessage, scoreLabel } from '@/lib/scan/leads-view'
import { contactsFromEnrichments } from '@/lib/people/rank'
import { publishedEmail, publishedContact } from '@/lib/outreach/published-email'
import SourceMetrics from './source-metrics'
import { WarmConnections, WarmPath } from './warm-path'
import VerificationFixture from './verification-fixture'

const claimFromSource = (l: { source_url: string; company_domain: string | null }): boolean => {
  try {
    const h = new URL(l.source_url).hostname.toLowerCase()
    const d = (l.company_domain ?? '').toLowerCase()
    return !(d && (h === d || h.endsWith('.' + d)))
  } catch { return true }
}

interface Lead { sequence?: { status: string; step: number; next_due_at: number | null; stop_reason: string | null } | null; id: string; name: string; company: string; contact: string | null; signal: string; source_url: string; score: number; evidence_excerpt: string | null; event_date: string | null; date_status: string | null; confidence: number | null; review_reason: string | null; company_domain: string | null; human_confirmed_at: number | null; human_confirmed_from: string | null; fit: number | null; intent: number | null; action: number | null; why: string | null; signals: string | null; icp_match: string | null; watch_new?: number; seen_before?: number; stage?: string | null; enrichments?: { connector: string; kind: string; value: string; label: string | null; confidence: number | null; source_url: string; source_date: string; entity_status?: 'heuristic' | 'unconfirmed' | null }[]; events?: { id: string; event_type: string; summary: string; source_url: string; source_published_at: string | null; last_seen_at: number; fresh: boolean; entity_status?: 'heuristic' | 'unconfirmed' | null }[]; priority?: { graded: boolean; fit: number | null; intent: number | null; action: number | null; evidence_score: number; reasons: string[]; uncounted: string[] } | null; lookalike?: { state: 'insufficient' | 'scored'; cohort_size: number; matches: number; matched_on: string[] } | null }
interface Icp { summary: string; who: string[]; industries: string[]; sizes: string[]; where: string[]; signals: string[]; exclude: string[] }
interface JobSummary { id: string; status: string; error: string | null; query: string | null; business_name: string; csv_domain: string | null; created_at: number; finished_at: number | null; candidates: number | null; verified: number | null; needs_review: number | null; dropped: number | null; lead_count: number; test_only: boolean }
interface Watch { id: string; query: string; active: boolean; next_run_at: number | null; last_run_at: number | null; paused_reason: string | null; last_job_id: string | null; last_status: string | null; new_leads: number }
interface Monitor { id: string; query: string; interval_hours: number; enabled: number; paused_reason: string | null; next_run_at: number | null; last_new_count: number | null; run_count: number }
interface Quality { candidates: number; passed: number | null; needs_review: number | null; dropped: number | null; drop_reasons: Record<string, number> }
interface CsvRow { domain: string; status: 'pending' | 'skipped' | 'queued' | 'running' | 'done' | 'failed'; job_id: string | null; leads: number | null; error: string | null }
interface CsvBatch { batch_id: string; total: number; note: string | null; counts: Record<string, number>; rows: CsvRow[]; quota_stop?: boolean }
interface CommenterRow { profile_url: string; name: string; name_source: 'csv' | 'derived'; title: string | null; company: string | null; lead_id: string | null }
interface CommenterBatch { batch_id: string; context: string; total: number; note: string | null; job_id: string | null; rows: CommenterRow[] }

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
const REVIEW: Record<string, string> = { counterparty_signal: 'Names this company as someone else\'s customer - not evidence of its own buying intent', job_closed: 'Source says applications are closed - historical hiring evidence, not an active opening', quote_unconfirmed: 'The saved quote could not be confirmed on the source', login_required: 'Source requires sign-in - evidence unknown', blocked_by_site: 'The site blocked our check', needs_javascript: 'The page needs JavaScript to show its content' }

// Enrichment labels join example titles with '; ' - older rows can repeat one
// title per posting. Show each distinct title once; the count stays untouched.
function dedupeLabel(label: string): string {
  const seen = new Set<string>()
  return label.split('; ').map(t => t.trim()).filter(t => {
    const k = t.toLowerCase()
    if (!t || seen.has(k)) return false
    seen.add(k)
    return true
  }).join('; ')
}

export default function LeadsClient() {
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<Icp | null>(null)
  const [draftNote, setDraftNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [starting, setStarting] = useState(false)
  const [icp, setIcp] = useState<{ icp: Icp; source: string } | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [status, setStatus] = useState<string>('')
  const [leadsSoFar, setLeadsSoFar] = useState(0)
  const [leads, setLeads] = useState<Lead[]>([])
  const [error, setError] = useState('')
  const [quality, setQuality] = useState<Quality | null>(null)
  const [jobError, setJobError] = useState('')
  const [statusError, setStatusError] = useState<'not_found' | 'unavailable' | null>(null)
  const statusFails = useRef(0)
  const [useGithub, setUseGithub] = useState(false)
  const [useYoutube, setUseYoutube] = useState(false)
  const [useV2ex, setUseV2ex] = useState(false)
  const [feedText, setFeedText] = useState('')
  const [pageText, setPageText] = useState('')

  const lines = (v: string) => v.split('\n').map(x => x.trim()).filter(Boolean)

  const [drafted, setDrafted] = useState<Record<string, string>>({})
  const [pushed, setPushed] = useState<Record<string, string>>({})
  const [crmOn, setCrmOn] = useState(false)
  const [watches, setWatches] = useState<Watch[]>([])
  const [watchNote, setWatchNote] = useState('')
  const [monitors, setMonitors] = useState<Monitor[]>([])
  const [monError, setMonError] = useState('')
  const loadMonitors = () => fetch('/api/monitors').then(r => r.ok ? r.json() : null).then(j => { if (j) setMonitors(j.monitors) }).catch(() => {})
  useEffect(() => { void loadMonitors() }, [])
  const addMonitor = async () => { if (!query.trim()) return; setMonError(''); const r = await fetch('/api/monitors', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: query.trim(), ...(icp ? { icp: icp.icp } : {}) }) }); const j = await r.json().catch(() => ({})); if (!r.ok) return setMonError(j.error === 'monitor_limit' ? `Your plan allows ${j.limit} monitors.` : j.error === 'interval_too_short' ? `The shortest interval on your plan is ${j.min} hours.` : j.error || 'Could not create the monitor'); void loadMonitors() }
  const toggleMonitor = async (id: string, enabled: boolean) => { await fetch(`/api/monitors/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) }); void loadMonitors() }
  const removeMonitor = async (id: string) => { await fetch(`/api/monitors/${id}`, { method: 'DELETE' }); void loadMonitors() }
  const [csvBatch, setCsvBatch] = useState<CsvBatch | null>(null)
  const [csvNote, setCsvNote] = useState('')
  const [csvInvalid, setCsvInvalid] = useState<{ line: string; reason: string }[]>([])
  const [csvBusy, setCsvBusy] = useState(false)
  async function importCsv(file: File) {
    setCsvNote(''); setCsvInvalid([]); setCsvBusy(true)
    const text = await file.text().catch(() => '')
    const r = await fetch('/api/scan/csv', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ csv: text }) })
    const j = await r.json().catch(() => ({}))
    setCsvBusy(false)
    if (!r.ok) {
      setCsvNote(j.error === 'pro_only' ? 'Bulk import is a Pro feature. Upgrade in Settings.' : j.error === 'no_api_key' ? 'Add your AI key in Settings first. Every imported domain runs on it.' : j.error === 'No valid domains found' ? 'No valid domains found - one domain per line, like acme.com.' : j.error || 'Could not import the file')
      if (Array.isArray(j.invalid)) setCsvInvalid(j.invalid)
      return
    }
    setCsvInvalid(j.invalid ?? [])
    setCsvNote(`${j.accepted} domain${j.accepted === 1 ? '' : 's'} imported${j.overflow ? `, first ${j.max_domains} only` : ''}. Each runs as one scan on your AI key and counts toward your monthly scans.${j.message ? ` ${j.message}.` : ''}`)
    void pollCsv(j.batch_id)
  }
  async function pollCsv(batchId: string) {
    const r = await fetch(`/api/scan/csv/${batchId}`).catch(() => null)
    if (r?.ok) setCsvBatch(await r.json())
  }
  const [cmtBatch, setCmtBatch] = useState<CommenterBatch | null>(null)
  const [cmtNote, setCmtNote] = useState('')
  const [cmtInvalid, setCmtInvalid] = useState<{ line: string; reason: string }[]>([])
  const [cmtBusy, setCmtBusy] = useState(false)
  const [cmtText, setCmtText] = useState('')
  const [cmtContext, setCmtContext] = useState('')
  async function importCommenters() {
    setCmtNote(''); setCmtInvalid([]); setCmtBusy(true)
    const r = await fetch('/api/scan/commenters', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ csv: cmtText, context: cmtContext }) })
    const j = await r.json().catch(() => ({}))
    setCmtBusy(false)
    if (!r.ok) {
      setCmtNote(j.error === 'pro_only' ? 'Commenter import is a Pro feature. Upgrade in Settings.' : j.error || 'Could not import')
      if (Array.isArray(j.invalid)) setCmtInvalid(j.invalid)
      return
    }
    setCmtInvalid(j.invalid ?? [])
    setCmtNote(`${j.accepted} ${j.accepted === 1 ? 'person' : 'people'} imported${j.overflow ? `, first ${j.max_profiles} only` : ''}. They are in the table below; company enrichment runs in the background.${j.mode === 'urls' ? ' Names guessed from the link are marked derived.' : ''}`)
    setCmtText('')
    void pollCommenters(j.batch_id)
  }
  async function pollCommenters(batchId: string) {
    const r = await fetch(`/api/scan/commenters/${batchId}`).catch(() => null)
    if (r?.ok) setCmtBatch(await r.json())
  }
  async function deleteCommenters() {
    if (!cmtBatch) return
    setCmtBusy(true)
    const r = await fetch(`/api/scan/commenters/${cmtBatch.batch_id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' } })
    setCmtBusy(false)
    if (r.ok) { setCmtBatch(null); setCmtNote('Batch deleted - its leads and enrichments are gone.') }
    else setCmtNote('Could not delete the batch')
  }
  useEffect(() => { void fetch('/api/scan/commenters').then(r => r.ok ? r.json() : null).then(j => { if (j?.batch) setCmtBatch(j.batch) }).catch(() => {}) }, [])

  async function resumeCsv() {
    if (!csvBatch) return
    setCsvBusy(true)
    const r = await fetch(`/api/scan/csv/${csvBatch.batch_id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const j = await r.json().catch(() => ({}))
    setCsvBusy(false)
    if (!r.ok) { setCsvNote(j.error === 'quota_exceeded' ? 'Monthly scans are used up.' : j.error || 'Could not resume'); return }
    setCsvBatch(j)
  }
  const csvActive = !!csvBatch && ((csvBatch.counts.queued ?? 0) + (csvBatch.counts.running ?? 0) > 0)
  useEffect(() => {
    if (!csvActive || !csvBatch) return
    const t = setInterval(() => void pollCsv(csvBatch.batch_id), 5000)
    return () => clearInterval(t)
  }, [csvActive, csvBatch?.batch_id])

  const [hiddenCount, setHiddenCount] = useState(0)
  const [siteUrl, setSiteUrl] = useState('')
  const [siteBusy, setSiteBusy] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [showSeen, setShowSeen] = useState(false)
  async function pushCrm(leadId: string) {
    const r = await fetch('/api/crm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'push', lead_id: leadId }) })
    const j = await r.json().catch(() => ({}))
    setPushed(d => ({ ...d, [leadId]: r.ok ? (j.message || 'Pushed to CRM') : j.error || 'Push failed' }))
  }
  async function confirmReview(leadId: string) {
    const r = await fetch(`/api/leads/${leadId}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    if (r.ok) setLeads(ls => ls.map(l => l.id === leadId ? { ...l, human_confirmed_at: Math.floor(Date.now() / 1000), human_confirmed_from: l.review_reason, review_reason: null } : l))
  }
  async function withdrawConfirm(leadId: string) {
    const r = await fetch(`/api/leads/${leadId}/confirm`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' })
    if (r.ok) setLeads(ls => ls.map(l => l.id === leadId ? { ...l, review_reason: l.human_confirmed_from, human_confirmed_at: null, human_confirmed_from: null } : l))
  }
  async function makeDraft(leadId: string) {
    const r = await fetch('/api/outreach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lead_id: leadId }) })
    const j = await r.json()
    setDrafted(d => ({ ...d, [leadId]: r.ok ? 'Draft created from the free template. Review it in Outreach - the AI rewrite there is a separate click that uses your key.' : j.error || 'Could not create the draft' }))
  }

  async function preview(e: React.FormEvent) {
    e.preventDefault()
    setError(''); setDraft(null); setBusy(true)
    try {
      const r = await fetch('/api/scan/icp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { setError(knownErrorCopy(j.error) ?? (j.error === 'no_api_key' ? 'Add your AI key in Settings first.' : j.error || 'Could not build the profile')); return }
      setDraft(j.icp)
      setDraftNote(j.inferred ? 'dazl worked this out from your request. Edit anything that is off, then run the scan.' : 'dazl could not infer more, so it will use your words as they are. Add detail below if you like.')
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  // "Fill from my website": the returned profile is a draft for review - it is only
  // ever persisted if the user runs a scan with it. Nothing is auto-saved.
  async function fillFromSite() {
    setError(''); setSiteBusy(true)
    try {
      const r = await fetch('/api/scan/icp-from-url', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: siteUrl.trim() }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { setError(knownErrorCopy(j.error) ?? (j.error === 'no_api_key' ? 'Add your AI key in Settings first - filling from your website runs on your key.' : j.error === 'invalid' || j.error === 'not_public' ? 'That address is not a public website.' : j.error === 'js_only' || j.error === 'not_html' ? 'We could not read enough text from that page (it may need JavaScript). Try your about page, or describe your buyers above.' : j.error === 'blocked' || j.error === 'timeout' ? 'That site did not let us read it. Describe your buyers above instead.' : 'Could not read that site. Describe your buyers above instead.')); return }
      setDraft(j.icp)
      let host = 'your website'
      try { host = new URL(j.source).hostname } catch { /* keep generic */ }
      setDraftNote(`Filled from ${host}. Edit anything that is off, then run the scan.`)
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setSiteBusy(false)
    }
  }

  const [advReady, setAdvReady] = useState<string[]>([])
  const [advPick, setAdvPick] = useState<string[]>([])
  useEffect(() => { void fetch('/api/settings/advanced').then(r => r.ok ? r.json() : null).then(j => { if (j?.available) setAdvReady(j.platforms.filter((p: { consent: boolean; connected: boolean; enabled: boolean; operator_index?: boolean }) => p.consent && ((p.connected && p.enabled) || p.operator_index)).map((p: { platform: string }) => p.platform)) }).catch(() => {}) }, [])

  async function run(withIcp: Icp | null) {
    setError(''); setStarting(true)
    try {
      const r = await fetch('/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, ...(withIcp ? { icp: withIcp } : {}), ...(useGithub || useYoutube || useV2ex || feedText.trim() || pageText.trim() || advPick.length ? { sources: { adapters: [...(useGithub ? ['github'] : []), ...(useYoutube ? ['youtube'] : []), ...(useV2ex ? ['v2ex'] : []), ...(feedText.trim() ? ['rss'] : []), ...(pageText.trim() ? ['web'] : [])], feeds: lines(feedText), pages: lines(pageText), advanced: advPick } } : {}) }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { setError(knownErrorCopy(j.error) ?? (j.error === 'no_api_key' ? 'Add your AI key in Settings first. A scan needs it.' : j.error === 'trial_exhausted' ? 'Your 3 free scans are used up. Add your own AI key in Settings to keep scanning.' : j.error === 'quota_exceeded' ? 'You have used this month\'s scans. Upgrade in Settings.' : j.error || 'Could not start the scan')); return }
      setJobId(j.job_id); setStatus('pending'); setLeads([]); setQuality(null); setIcp(null); setDraft(null); setLeadsSoFar(0); setStatusError(null); statusFails.current = 0
    } catch {
      // A rejected fetch (offline, aborted) used to fail silently - the click looked dead.
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setStarting(false)
    }
  }

  useEffect(() => {
    if (!jobId || status === 'done' || status === 'failed' || statusError) return
    let stop = false
    const tick = async () => {
      const r = await fetch(`/api/scan/status?job_id=${jobId}`).catch(() => null)
      if (stop) return
      // 404: this account cannot see that scan - terminal, say so and stop.
      if (r && r.status === 404) { setStatusError('not_found'); return }
      // Network/5xx: the scan itself may be fine. Retry a few times, then surface a
      // status-load error with a retry affordance - never mark the scan failed.
      if (!r || !r.ok) {
        statusFails.current += 1
        if (statusFails.current >= 3) setStatusError('unavailable')
        return
      }
      statusFails.current = 0
      const s = await r.json()
      setStatus(s.status); setJobError(s.error ?? ''); setLeadsSoFar(s.lead_count ?? 0)
      setQuality(s.quality ?? null)
      if (s.icp) setIcp({ icp: s.icp, source: s.icp_source })
    }
    void tick() // immediate first check: a done deep link must not sit on a loading state for a full interval
    const t = setInterval(tick, 5000)
    return () => { stop = true; clearInterval(t) }
  }, [jobId, status, statusError])

  const loadLeads = async () => {
    if (!jobId) return
    const l = await fetch(`/api/leads?job_id=${jobId}${showHidden ? '&all=1' : ''}`)
    if (l.ok) { const j = await l.json(); setLeads(j.leads); setHiddenCount(j.hidden_count ?? 0) }
  }
  useEffect(() => { if (status === 'done') void loadLeads() }, [jobId, status, showHidden])
  useEffect(() => { fetch('/api/crm').then(r => r.ok ? r.json() : null).then(j => setCrmOn(!!j?.configured)).catch(() => {}) }, [])
  const loadWatches = async () => {
    const r = await fetch('/api/watch').catch(() => null)
    if (r?.ok) { const j = await r.json(); setWatches(j.watches ?? []) }
  }
  useEffect(() => { void loadWatches() }, [status])
  // Deep link: /app/leads?job_id=... (watch cards link here to show a past watch run).
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('job_id')
    if (id && /^[a-f0-9]{24}$/.test(id)) { setJobId(id); setStatus('loading') }
  }, [])
  const watchReq = async (body: Record<string, unknown>) => {
    setWatchNote('')
    const r = await fetch('/api/watch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null)
    const j = r ? await r.json().catch(() => null) : null
    if (!r?.ok) { setWatchNote(j?.error ?? 'Could not update the watch.'); return }
    if (j?.error) setWatchNote(j.error)
    await loadWatches()
  }
  const [pastJobs, setPastJobs] = useState<JobSummary[] | null>(null)
  // History: a returning user picks a past scan explicitly - nothing autoselects, so an
  // older job or a test fixture can never silently become the default view.
  useEffect(() => {
    if (jobId) return
    void fetch('/api/scan/jobs').then(r => r.ok ? r.json() : null).then(j => { if (j) setPastJobs(j.jobs ?? []) }).catch(() => {})
  }, [jobId])
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
  const visibleLeads = leads.filter(l => !l.review_reason && (showSeen || !l.seen_before))

  return (
    <div className="p-8">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight mb-1">Leads</h1>
          <p className="text-gray-400 text-sm mb-6">Companies matching your search, with the signal and source for each. Match is a heuristic - review fit yourself.</p>
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
            {advReady.map(p => <label key={p} className="flex items-center gap-2 text-gray-300"><input type="checkbox" checked={advPick.includes(p)} onChange={e => setAdvPick(e.target.checked ? [...advPick, p] : advPick.filter(x => x !== p))} /> {p === "x" ? "Also search X posts (via web index, no account risk)" : `Also search ${p} (uses operator session, posts may be flagged)`}</label>)}
            <p className="text-xs text-gray-500">Items from these sources are checked against their page like every other lead.</p>
          </div>
        </details>
        <div className="flex gap-2 mt-2 items-center">
          <input type="text" value={siteUrl} onChange={e => setSiteUrl(e.target.value)} maxLength={300} placeholder="Your website - we will fill the profile from it" className={`${input} flex-1`} />
          <button type="button" onClick={() => void fillFromSite()} disabled={siteBusy || siteUrl.trim().length < 5} className="text-gray-400 hover:text-white text-sm px-3 whitespace-nowrap disabled:opacity-40">{siteBusy ? 'Reading your site...' : 'Fill from my website'}</button>
        </div>
        <div className="flex gap-2 mt-2">
          <button disabled={busy} className="btn-primary">{busy ? 'Working out your profile...' : 'Find leads'}</button>
          <button type="button" disabled={query.trim().length < 3 || starting} onClick={() => run(null)} className="text-gray-400 hover:text-white text-sm px-3 disabled:opacity-40">{starting ? 'Starting...' : 'Skip review, just run'}</button>
        </div>
      </form>
      <details className="mb-4 text-sm">
        <summary className="cursor-pointer text-gray-400">Bulk import company domains (Pro)</summary>
        <div className="card p-4 mt-2">
          <p className="text-gray-500 text-xs mb-2">A CSV or text file with one company domain per line, up to 50. Each domain runs as its own scan on your AI key - contacts and signals land in the table below. Blank rows are skipped; bad rows are flagged.</p>
          <input type="file" accept=".csv,.txt,text/csv,text/plain" disabled={csvBusy} onChange={e => { const f = e.target.files?.[0]; if (f) void importCsv(f); e.target.value = '' }} className="text-xs text-gray-300 file:mr-3 file:font-mono file:uppercase file:text-xs file:border file:border-black file:px-2 file:py-1 file:bg-transparent file:text-white hover:file:bg-black" />
          {csvNote && <p className="text-xs text-gray-400 mt-2">{csvNote}</p>}
          {csvInvalid.length > 0 && (
            <div className="mt-2">
              <p className="text-xs text-yellow-500">Skipped {csvInvalid.length} invalid row{csvInvalid.length === 1 ? '' : 's'}:</p>
              <ul className="text-xs text-gray-500 ml-4 list-disc">{csvInvalid.slice(0, 10).map(r => <li key={r.line}>{r.line} - {r.reason}</li>)}</ul>
              {csvInvalid.length > 10 && <p className="text-xs text-gray-600">and {csvInvalid.length - 10} more</p>}
            </div>
          )}
          {csvBatch && (
            <div className="mt-3">
              <div className="flex items-center gap-3 text-xs text-gray-400 mb-1">
                <span>{csvBatch.total} domains: {(['done','running','queued','failed','pending'] as const).filter(k => csvBatch.counts[k]).map(k => `${csvBatch.counts[k]} ${k === 'pending' ? 'waiting' : k}`).join(', ')}</span>
                {(csvBatch.counts.pending ?? 0) > 0 && !csvActive && <button onClick={() => void resumeCsv()} disabled={csvBusy} className="font-mono text-xs uppercase border border-black px-2 py-1 hover:bg-black hover:text-white">Resume</button>}
              </div>
              {csvBatch.note && <p className="text-xs text-yellow-500 mb-1">{csvBatch.note}</p>}
              <div className="divide-y divide-white/5 border-t border-white/5">
                {csvBatch.rows.map(r => (
                  <div key={r.domain} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-xs">
                    <span className="text-gray-200 min-w-0 flex-1 truncate">{r.domain}</span>
                    <span className={r.status === 'failed' ? 'text-red-400' : r.status === 'done' ? 'text-green-300' : 'text-gray-500'}>
                      {r.status === 'queued' ? 'queued' : r.status === 'running' ? 'scanning' : r.status === 'pending' ? 'waiting - quota reached' : r.status === 'failed' ? `failed${r.error === 'budget_stopped' ? ' - stopped by run budget' : r.error === 'no_candidates' ? ' - nothing found' : ''}` : 'done'}
                    </span>
                    {r.status === 'done' && r.job_id && <a className="underline text-[#111]" href={`/app/leads?job_id=${r.job_id}`}>{r.leads ?? 0} lead{(r.leads ?? 0) === 1 ? '' : 's'}</a>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </details>
      <details className="mb-4 text-sm">
        <summary className="cursor-pointer text-gray-400">Import post commenters (Pro)</summary>
        <div className="card p-4 mt-2">
          <p className="text-gray-500 text-xs mb-2">People who engaged with a post, imported as leads. Upload a CSV with profile URL, name, title and company columns, or paste LinkedIn profile links (linkedin.com/in/...) one per line, up to 100. Links are never opened - no scraping. Names guessed from a link are marked derived; your CSV names win. Only your Apollo/PDL key (org lookup, 1 credit per company, max 50) and free sources enrich them.</p>
          <input value={cmtContext} onChange={e => setCmtContext(e.target.value)} maxLength={500} placeholder="Context: what they engaged with, e.g. Commented on my post about CRM switching costs" className="field w-full mb-2 text-xs" />
          <textarea value={cmtText} onChange={e => setCmtText(e.target.value)} rows={4} placeholder={'profile_url,name,title,company\nhttps://www.linkedin.com/in/jane-doe,Jane Doe,VP Sales,Acme'} className="field w-full mb-2 text-xs font-mono" />
          <div className="flex items-center gap-3">
            <button onClick={() => void importCommenters()} disabled={cmtBusy || !cmtText.trim() || !cmtContext.trim()} className="font-mono text-xs uppercase border border-black px-2 py-1 hover:bg-black hover:text-white disabled:opacity-40">Import</button>
            <label className="text-xs text-gray-400 underline cursor-pointer">or upload a file<input type="file" accept=".csv,.txt,text/csv,text/plain" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) void f.text().then(t => setCmtText(t)); e.target.value = '' }} /></label>
          </div>
          {cmtNote && <p className="text-xs text-gray-400 mt-2">{cmtNote}</p>}
          {cmtInvalid.length > 0 && (
            <div className="mt-2">
              <p className="text-xs text-yellow-500">Skipped {cmtInvalid.length} invalid row{cmtInvalid.length === 1 ? '' : 's'}:</p>
              <ul className="text-xs text-gray-500 ml-4 list-disc">{cmtInvalid.slice(0, 10).map(r => <li key={r.line}>{r.line} - {r.reason}</li>)}</ul>
              {cmtInvalid.length > 10 && <p className="text-xs text-gray-600">and {cmtInvalid.length - 10} more</p>}
            </div>
          )}
          {cmtBatch && (
            <div className="mt-3">
              <div className="flex items-center gap-3 text-xs text-gray-400 mb-1">
                <span>{cmtBatch.total} imported: {cmtBatch.context}</span>
                <button onClick={() => void deleteCommenters()} disabled={cmtBusy} className="font-mono text-xs uppercase border border-red-900 text-red-400 px-2 py-1 hover:bg-red-900 hover:text-white">Delete batch</button>
              </div>
              <div className="divide-y divide-white/5 border-t border-white/5">
                {cmtBatch.rows.map(r => (
                  <div key={r.profile_url} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-xs">
                    <span className="text-gray-200 min-w-0 flex-1 truncate">{r.name}{r.title ? ` - ${r.title}` : ''}{r.company ? `, ${r.company}` : ''}</span>
                    {r.name_source === 'derived' && <span className="text-yellow-500">name derived from link</span>}
                    {r.lead_id && <a className="underline text-[#111]" href={`/app/leads?job_id=${cmtBatch.job_id}`}>in leads</a>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </details>
      {draft && (
        <div className="card p-4 mb-6 text-sm">
          <div className="flex items-center justify-between gap-3 mb-3">
            <p className="text-gray-400">{draftNote}</p>
            <button onClick={() => run(draft)} disabled={starting} className="btn-primary shrink-0 disabled:opacity-40">{starting ? 'Starting...' : 'Run scan with this profile'}</button>
          </div>
          <label className="block text-xs text-gray-500 mb-1">Who you want</label>
          <textarea className={`${input} w-full mb-2`} rows={2} maxLength={300} value={draft.summary} onChange={e => setDraft({ ...draft, summary: e.target.value })} />
          {([['who', 'Roles or kinds of buyer (one per line)'], ['industries', 'Industries (one per line, empty means any)'], ['sizes', 'Company sizes (one per line, empty means any)'], ['where', 'Where (one per line, empty means anywhere)'], ['signals', 'Buying signals to look for (one per line)'], ['exclude', 'Skip these (one per line)']] as const).map(([k, label]) => (
            <div key={k}>
              <label className="block text-xs text-gray-500 mb-1">{label}</label>
              <textarea className={`${input} w-full mb-2`} rows={2} value={draft[k].join('\n')} onChange={e => setDraft({ ...draft, [k]: lines(e.target.value) })} />
            </div>
          ))}
          <button onClick={() => run(draft)} disabled={starting} className="btn-primary disabled:opacity-40">{starting ? 'Starting...' : 'Run scan with this profile'}</button>
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
          <div className="flex items-center gap-3 mt-2">
            <button className="underline text-[#111] text-xs" onClick={() => { setDraft(icp.icp); setDraftNote('Edit the profile and run again.') }}>Edit and run again</button>
            <button className="underline text-[#111] text-xs" onClick={() => void watchReq({ query: query.trim(), icp: icp.icp })}>Watch this weekly</button>
          </div>
          {watchNote && <p className="text-xs text-gray-500 mt-1">{watchNote}</p>}
        </details>
      )}
      {error && <p className="text-red-400 text-sm mb-4">{error}</p>}
      {jobId && status === 'loading' && !statusError && (
        <div className="card p-4 mb-4 flex items-center gap-3">
          <span className="inline-block h-4 w-4 rounded-full border-2 border-gray-500 border-t-white animate-spin" aria-hidden />
          <div className="text-sm text-gray-400">Loading this scan...</div>
        </div>
      )}
      {jobId && (status === 'pending' || status === 'running') && (
        <div className="card p-4 mb-4 flex items-center gap-3">
          <span className="inline-block h-4 w-4 rounded-full border-2 border-gray-500 border-t-white animate-spin" aria-hidden />
          <div className="text-sm">
            <div>Scanning - this can take a few minutes.</div>
            <div className="text-gray-400 text-xs">{leadsSoFar > 0 ? `${leadsSoFar} lead${leadsSoFar === 1 ? '' : 's'} so far` : 'Searching sources...'}</div>
          </div>
        </div>
      )}
      {jobId && status === 'failed' && <p className="text-gray-400 text-sm mb-4">{jobError === 'budget_stopped' ? 'This run stopped before the paid research fallback: its own per-run budget disabled that step. Import again without that budget control to search further.' : jobError === 'no_candidates' ? 'No candidates found for that search. Try rephrasing or broadening it - this scan did not count toward your monthly scans.' : jobError === 'trial_key_invalid' ? 'The scan service is having trouble right now. Try again later - this scan did not count toward your free scans.' : jobError === 'key_unreadable' ? KEY_UNREADABLE_COPY.replace(/\.$/, ', then run the scan again.') : 'Scan failed. Try again.'}</p>}
      {jobId && statusError && (
        <p className="text-gray-400 text-sm mb-4">{statusError === 'not_found'
          ? <>That scan was not found in this account. <a className="underline text-[#111]" href="/app/leads">View your past scans</a>.</>
          : <>Could not load the scan status - this may be a connection problem, and the scan itself may still be running. <button className="underline text-[#111]" onClick={() => { statusFails.current = 0; setStatusError(null) }}>Retry</button></>}</p>
      )}
      {watches.length > 0 && (
        <div className="card p-4 mb-4 text-sm">
          <h2 className="text-sm font-semibold mb-1">Weekly watches</h2>
          <p className="text-gray-500 text-xs mb-2">These searches re-run once a week and only show leads you have not seen. They count toward your monthly scans.</p>
          {watches.map(w => (
            <div key={w.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 border-t border-white/5 first:border-t-0">
              <span className="text-gray-200 min-w-0 flex-1 truncate" title={w.query}>{w.query}</span>
              {!w.active && <span className="text-yellow-500 text-xs">{w.paused_reason === 'no_key' ? 'Paused - the scan service key is missing' : w.paused_reason === 'quota' ? 'Paused - monthly scans are used up' : 'Paused'}</span>}
              {w.active && w.next_run_at && <span className="text-gray-500 text-xs">next run {new Date(w.next_run_at * 1000).toLocaleDateString()}</span>}
              {w.last_status === 'running' || w.last_status === 'pending' ? <span className="text-gray-500 text-xs">running now</span> : null}
              {w.last_job_id && w.new_leads > 0 && <a className="underline text-[#111] text-xs" href={`/app/leads?job_id=${w.last_job_id}`}>{w.new_leads} new</a>}
              {w.last_job_id && w.new_leads === 0 && w.last_status === 'done' && <a className="underline text-gray-500 text-xs" href={`/app/leads?job_id=${w.last_job_id}`}>last run: nothing new</a>}
              {w.active
                ? <button className="text-gray-500 hover:text-white text-xs" onClick={() => void watchReq({ action: 'pause', id: w.id })}>Pause</button>
                : <button className="text-gray-500 hover:text-white text-xs" onClick={() => void watchReq({ action: 'resume', id: w.id })}>Resume</button>}
              <button className="text-gray-500 hover:text-white text-xs" onClick={() => void watchReq({ action: 'delete', id: w.id })}>Delete</button>
            </div>
          ))}
        </div>
      )}
      {quality && status === 'done' && (
        <p className="text-gray-400 text-sm mb-4">
          {quality.candidates} found: {quality.passed ?? 0} source-checked, {quality.needs_review ?? 0} need{(quality.needs_review ?? 0) === 1 ? 's' : ''} your review, {quality.dropped ?? 0} dropped
          {Object.keys(quality.drop_reasons).length > 0 && <> ({Object.entries(quality.drop_reasons).map(([k, n]) => `${n} ${REASON[k] ?? k}`).join(', ')})</>}.
        </p>
      )}
      <SourceMetrics />
      <WarmConnections />
      <VerificationFixture />
      {!jobId && pastJobs && pastJobs.length > 0 && (
        <div className="card divide-y divide-white/5 mb-4">
          <div className="p-4">
            <h2 className="text-sm font-semibold">Past scans</h2>
            <p className="text-gray-500 text-xs mt-0.5">Pick one to review its leads. Nothing runs until you start a new scan above.</p>
          </div>
          {pastJobs.map(j => (
            <a key={j.id} href={`/app/leads?job_id=${j.id}`} className="block p-4 hover:bg-white/5">
              <div className="text-sm font-medium">
                {j.test_only && <span className="text-gray-500">test only · </span>}
                {j.query ?? (j.csv_domain ? `CSV import: ${j.csv_domain}` : j.business_name)}
              </div>
              <div className="text-gray-500 text-xs mt-0.5">
                {new Date(j.created_at * 1000).toLocaleDateString()} · {j.status === 'done'
                  ? (j.candidates !== null
                      ? `${j.candidates} found: ${j.verified ?? 0} source-checked, ${j.needs_review ?? 0} need${(j.needs_review ?? 0) === 1 ? 's' : ''} your review, ${j.dropped ?? 0} dropped`
                      : `${j.lead_count} lead${j.lead_count === 1 ? '' : 's'}`)
                  : j.status === 'failed' ? 'failed'
                  : 'still running'}
              </div>
            </a>
          ))}
        </div>
      )}
      <div className="card divide-y divide-white/5">
        {visibleLeads.length === 0 ? (
          // Loading, failed and status-error states have their own truthful copy above.
          status === 'loading' || status === 'failed' || statusError ? null
            : <p className="p-10 text-center text-gray-500 text-sm">{emptyLeadsMessage(status, 0, hiddenCount, quality?.needs_review) ?? ''}</p>
        ) : visibleLeads.map(l => (
          <div key={l.id} className="p-4 text-sm">
            {l.sequence && <p className="text-xs text-[#555] mb-2">Sequence: {l.sequence.status} / {l.sequence.step} steps sent{l.sequence.next_due_at ? ` / next due ${new Date(l.sequence.next_due_at * 1000).toLocaleString()}` : ''}{l.sequence.stop_reason ? ` (${l.sequence.stop_reason})` : ''}</p>}
<div className="font-medium">{l.company_domain ? <a className="underline decoration-white/30 hover:decoration-white" href={`https://${l.company_domain}`} target="_blank" rel="noopener noreferrer nofollow">{l.company || l.name}</a> : (l.company || l.name)} <span className="text-gray-500">{scoreLabel(l.score, l.fit, l.intent)}</span>
              {!!l.watch_new && <span className="ml-2 text-[10px] uppercase tracking-wide text-green-300 border border-green-300/30 px-1 py-0.5">new</span>}
              {l.stage === 'booked_call' && <span className="ml-2 text-[10px] uppercase tracking-wide text-blue-300 border border-blue-300/30 px-1 py-0.5">booked call</span>}
              {l.fit != null && <span className="ml-2 text-xs font-normal text-gray-300 border border-white/15 px-1.5 py-0.5">fit {l.fit}/5 · intent {l.intent ?? '?'}/5 · action {l.action ?? '?'}/5</span>}
              {l.fit != null && l.icp_match && (() => {
                let m: { role?: string; industry?: string; size?: string; location?: string; note?: string } | null = null
                try { m = JSON.parse(l.icp_match) } catch { m = null }
                if (!m) return null
                const chip = (label: string, v?: string) => !v ? null : <span key={label} className={`text-[10px] px-1 border ${v === 'match' ? 'text-green-300 border-green-300/30' : v === 'mismatch' ? 'text-red-300 border-red-300/30' : 'text-gray-500 border-white/10'}`} title={m.note || `${label}: ${v}`}>{label}</span>
                return <span className="ml-1 inline-flex gap-0.5 align-middle">{chip('role', m.role)}{chip('industry', m.industry)}{chip('size', m.size)}{chip('location', m.location)}</span>
              })()}
            </div>
            <div className="text-gray-400">{claimFromSource(l) ? `Source claims: ${l.signal}` : l.signal}</div>
            {l.why && <div className="text-xs text-gray-300 mt-1">Why now: {l.why}</div>}
            {parseSignals(l.signals).length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">{parseSignals(l.signals).map(sg => <span key={sg} className="text-[10px] uppercase tracking-wide text-gray-500 border border-white/10 px-1 py-0.5">{sg.replace(/_/g, ' ')}</span>)}</div>
            )}
            {l.enrichments && l.enrichments.some(e => e.kind === 'contact') && (() => {
              const people = contactsFromEnrichments(l.enrichments, icp && icp.icp.who.length > 0 ? icp.icp.who.join('; ') : '')
              return (
                <div className="text-xs mt-1 space-y-0.5">
                  <div className="text-gray-500 uppercase tracking-wide text-[10px]">Right people</div>
                  {people.map(p => (
                    <div key={p.name + (p.title ?? '')} className="text-gray-400">
                      <span className="text-[#111]">{p.name}</span>{p.title ? ` - ${p.title}` : ''}{' '}
                      <span className="text-gray-500">via {p.connector}{p.tier === 'strong' ? `, title matches: ${p.matched.join(', ')}` : p.tier === 'weak' ? `, weak title match: ${p.matched.join(', ')}` : ', no title match'}</span>{' '}
                      {p.linkedin && <a className="underline text-[#111]" href={p.linkedin} target="_blank" rel="noopener noreferrer nofollow">profile</a>}
                    </div>
                  ))}
                  <div className="text-gray-500">{icp && icp.icp.who.length > 0 ? 'Ordered by title match to your profile - a heuristic. A match is not a verified decision maker or current employee; verify the person before reaching out.' : 'People found for this company - verify the person before reaching out.'}</div>
                </div>
              )
            })()}
            <WarmPath leadId={l.id} company={l.company} signal={l.signal} />
            {l.enrichments && l.enrichments.some(e => e.kind !== 'contact') && (
              <div className="text-xs mt-1 space-y-0.5">
                {l.enrichments.filter(e => e.kind !== 'contact').map(e => (
                  <div key={e.kind + e.value} className="text-gray-400">
                    <span className="text-[#111]">{e.value}</span>{e.label ? ` (${dedupeLabel(e.label)})` : ''} <span className="text-gray-500">{e.kind === 'tech' ? 'seen on the company website' : e.connector === 'sitecrawl' ? 'from the company contact page' : e.connector === 'hunter' ? 'via Hunter (earlier)' : `via ${e.connector}`}{e.confidence !== null && !e.connector.startsWith('signals:') ? `, ${e.confidence}% confidence` : ''}{e.entity_status === 'unconfirmed' ? ' - entity unconfirmed (name match only), check the source before relying on this' : e.entity_status === 'heuristic' ? ' - entity matched by name only (heuristic, not independently confirmed)' : ''}, seen {e.source_date}</span>{' '}
                    <a className="underline text-[#111]" href={e.source_url} target="_blank" rel="noopener noreferrer nofollow">source</a>
                  </div>
                ))}
              </div>
            )}
            {l.priority && (l.priority.graded || l.priority.evidence_score > 0) && (
              <div className="text-xs mt-1 space-y-0.5">
                <div className="text-gray-500 uppercase tracking-wide text-[10px]">Why this company, why now</div>
                {l.priority.graded ? (
                  <div className="text-gray-400">ICP grade {l.priority.fit} + {l.priority.intent} + {l.priority.action} = {(l.priority.fit ?? 0) + (l.priority.intent ?? 0) + (l.priority.action ?? 0)}/15, evidence <span className="text-[#111]">+{l.priority.evidence_score}</span></div>
                ) : (
                  <div className="text-gray-400">Not ICP-graded - evidence +{l.priority.evidence_score}, but fit is unverified</div>
                )}
                {l.priority.reasons.map((r, i) => <div key={`r${i}`} className="text-gray-400">+ {r}</div>)}
                {l.priority.uncounted.map((u, i) => <div key={`u${i}`} className="text-gray-500">not scored: {u}</div>)}
                <div className="text-gray-500">Leads rank by ICP fit first, then evidence - more evidence never outranks a better fit. Heuristic, not a prediction: same type + source-stated date grouped as one event; source independence not verified (syndication possible).</div>
              </div>
            )}
            {l.lookalike && (
              <div className="text-xs mt-1 text-gray-400">
                {l.lookalike.state === 'scored'
                  ? <>Resembles {l.lookalike.matches} of {l.lookalike.cohort_size} of your past fit-4+ or interested-reply leads{l.lookalike.matched_on.length > 0 ? ` (matched: ${l.lookalike.matched_on.join(', ')})` : ''} - keyword/field overlap, a heuristic, not a prediction. Those past leads are not customers or proven buyers.</>
                  : <>Not enough past fit-4+ or interested-reply leads for a lookalike signal yet ({l.lookalike.cohort_size} of 3 needed) - nothing is invented in the meantime.</>}
              </div>
            )}
            {l.events && l.events.length > 0 && (
              <div className="text-xs mt-1 space-y-0.5">
                <div className="text-gray-500 uppercase tracking-wide text-[10px]">Company history</div>
                {l.events.map(ev => (
                  <div key={ev.id} className="text-gray-400">
                    <span className="text-gray-500">{/sec\.gov/.test(ev.source_url) ? 'SEC filing' : ev.event_type.replace(/_/g, ' ')}:</span> <span className="text-[#111]">{ev.summary}</span>{' '}
                    <span className="text-gray-500">{ev.source_published_at ? `dated ${ev.source_published_at}, ` : ''}seen {new Date(ev.last_seen_at * 1000).toISOString().slice(0, 10)}{ev.fresh ? '' : ' (older)'}{ev.entity_status === 'unconfirmed' ? ' - entity unconfirmed (name match only), not used for ranking' : ev.entity_status === 'heuristic' ? ' - name match (heuristic)' : ''}</span>{' '}
                    <a className="underline text-[#111]" href={ev.source_url} target="_blank" rel="noopener noreferrer nofollow">source</a>
                  </div>
                ))}
              </div>
            )}
            {l.evidence_excerpt && <blockquote className="text-gray-500 text-xs border-l border-white/10 pl-3 my-1">{l.human_confirmed_at ? 'Unconfirmed quote: ' : ''}&ldquo;{l.evidence_excerpt}&rdquo;</blockquote>}
            <span className="text-gray-500 text-xs mr-3">{l.confidence === null ? (l.human_confirmed_at ? 'confirmed by you - dazl did not verify the quote' : 'not verified') : `confidence ${l.confidence}`}{l.event_date ? `, ${l.event_date}${l.date_status === 'unverified' ? ' (date not confirmed on page)' : ''}` : ''}</span>
            {l.human_confirmed_at !== null && l.human_confirmed_at !== undefined && (
              <button onClick={() => withdrawConfirm(l.id)} className="text-gray-600 hover:text-red-400 text-xs mr-3" title={l.human_confirmed_from ? `Was in review: ${REVIEW[l.human_confirmed_from] ?? l.human_confirmed_from}` : undefined}>withdraw confirmation</button>
            )}
            <a className="underline text-[#111] text-xs" href={l.source_url} target="_blank" rel="noopener noreferrer nofollow">source</a>
            {(() => {
              const pc = publishedContact(l)
              const draftTo = publishedEmail(l)
              return <>
                {pc && pc.purpose === 'sales' && <span className="text-gray-500 text-xs ml-3">{pc.email}</span>}
                {pc && pc.purpose === 'non-sales' && <span className="text-gray-500 text-xs ml-3">{pc.email} - published {pc.purposeHint} inbox, not a sales contact</span>}
                {!pc && l.contact && <span className="text-gray-500 text-xs ml-3">{l.contact}</span>}
                {draftTo && (l.confidence !== null || l.human_confirmed_at !== null) && !(l.fit === 0 && l.intent === null) && (
                  drafted[l.id]
                    ? <span className="text-gray-400 text-xs ml-3">{drafted[l.id]}</span>
                    : <button onClick={() => makeDraft(l.id)} className="font-mono text-xs uppercase border border-black px-2 py-1 ml-3 hover:bg-black hover:text-white">Draft email</button>)}
              </>
            })()}
            {crmOn && (pushed[l.id]
              ? <span className="text-gray-400 text-xs ml-2">{pushed[l.id]}</span>
              : <button onClick={() => pushCrm(l.id)} className="font-mono text-xs uppercase border border-black px-2 py-1 ml-2 hover:bg-black hover:text-white">Push to CRM</button>)}
          </div>
        ))}
      </div>
      {status === 'done' && leads.some(l => l.seen_before) && (
        <button onClick={() => setShowSeen(v => !v)} className="text-gray-500 hover:text-white text-xs mt-2 block">
          {showSeen ? 'Hide leads from earlier scans' : `Show ${leads.filter(l => l.seen_before).length} lead${leads.filter(l => l.seen_before).length === 1 ? '' : 's'} seen in your earlier scans`}
        </button>
      )}
      {status === 'done' && (hiddenCount > 0 || showHidden) && (
        <button onClick={() => setShowHidden(v => !v)} className="text-gray-500 hover:text-white text-xs mt-2">
          {showHidden ? 'Hide hidden leads' : `Show ${hiddenCount} hidden lead${hiddenCount === 1 ? '' : 's'} (low fit or ungraded)`}
        </button>
      )}
      {leads.some(l => l.review_reason) && (
        <>
          <h2 className="text-sm font-semibold mt-8 mb-2">Needs your review</h2>
          <p className="text-gray-500 text-xs mb-3">dazl could not confirm these leads, so they will not be emailed. Open the source and check them yourself - if a lead checks out, confirm it and it moves into your list as confirmed by you, never as source-checked.</p>
          <div className="card divide-y divide-white/5">
            {leads.filter(l => l.review_reason).map(l => (
              <div key={l.id} className="p-4 text-sm">
                <div className="font-medium">{l.company || l.name}</div>
                <div className="text-gray-400">{claimFromSource(l) ? `Source claims: ${l.signal}` : l.signal}</div>
                <span className="text-yellow-500 text-xs mr-3">{REVIEW[l.review_reason ?? ''] ?? 'Not verified'}</span>
                <a className="underline text-[#111] text-xs" href={l.source_url} target="_blank" rel="noopener noreferrer nofollow">source</a>
                <button onClick={() => confirmReview(l.id)} className="font-mono text-xs uppercase border border-black px-2 py-1 ml-3 hover:bg-black hover:text-white">I checked this - use it</button>
                {l.review_reason === 'quote_unconfirmed' && l.evidence_excerpt && (
                  <div className="text-xs text-gray-500 mt-1">Unconfirmed quote: "{l.evidence_excerpt}"</div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {monitors.length > 0 && (
        <div className="mt-6">
          <h2 className="text-sm font-semibold mb-2 text-gray-300">Continuous Monitors</h2>
          <p className="text-gray-500 text-xs mb-2">Re-runs your search on a schedule. New companies show up here automatically.</p>
          <div className="space-y-1">
            {monitors.map(m => (
              <div key={m.id} className="flex items-center gap-3 text-xs text-gray-400 bg-white/5 rounded px-3 py-2">
                <span className="flex-1 truncate">{m.query}</span>
                {m.last_new_count != null && <span className="text-green-400">+{m.last_new_count} new</span>}
                <span>{m.run_count ?? 0} runs</span>
                <button onClick={() => toggleMonitor(m.id, !m.enabled)} className="hover:text-white">{m.enabled ? 'Pause' : 'Resume'}</button>
                <button onClick={() => removeMonitor(m.id)} className="hover:text-red-400">Delete</button>
              </div>
            ))}
          </div>
          {monError && <p className="text-red-400 text-xs mt-1">{monError}</p>}
        </div>
      )}
    </div>
  )
}