'use client'
import { windowNotice } from '@/lib/scan/window-notice'
import { KEY_UNREADABLE_COPY, knownErrorCopy } from '@/lib/error-copy'
import { useEffect, useRef, useState } from 'react'
import { buildSources } from '@/lib/sources/ui-sources'
import { emptyLeadsMessage, scoreLabel, quoteNote } from '@/lib/scan/leads-view'
import { eventTypeLabel } from '@/lib/events/labels'
import { companySearchEligible } from '@/lib/scan/find-contact-eligible'
import { contactsFromEnrichments, PEOPLE_SOURCE } from '@/lib/people/rank'
import { OpportunityCardView } from './opportunity-card'
import { leadCardSummary } from '@/lib/scan/lead-card'
import { coreSources, socialLabel, socialSources, usableLabels, type Advanced, type KeyState, type ServerSources, type SourceRow } from '@/lib/scan/source-availability'
import { barCopy, scanCounts } from '@/lib/outreach/scan-drafts'
import { publishedEmail, publishedContact, contactSearchNote, domainBasisNote, domainBasisText } from '@/lib/outreach/published-email'
import { domainReviewFor } from '@/lib/outreach/domain-review'
import SourceReview from './source-review'
import HiringFeed from './hiring-feed'
import QualifyPreview from './qualify-preview'
import PageSignals from './page-signals'
import SourceMetrics from './source-metrics'
import { WarmConnections, WarmPath } from './warm-path'
import VerificationFixture from './verification-fixture'
import { eventDateCopy } from '@/lib/scan/date-copy'
import BudgetPanel from './budget-panel'
import { budgetFromForm, EMPTY_BUDGET_FORM, type BudgetForm } from '@/lib/scan/run-budget-form'
import { evidenceOriginLabel, purgedNote } from '@/lib/scan/evidence-origin'
import { playSuggestions, type PlaySuggestions } from '@/lib/play-suggestions'

// Reject on the card is the existing reversible quarantine, with its own reason so the card can say "Rejected".
// Reject asks for an optional reason (a preset or a few words); it is stored as "Rejected" or "Rejected: <reason>".
const REJECT_PRESETS = ['Not a fit', 'Wrong company', 'Wrong contact', 'Already a customer']
const rejectReason = (why: string) => { const t = why.replace(/\s+/g, ' ').trim().slice(0, 120); return t ? `Rejected: ${t}` : 'Rejected' }
const isRejection = (r: string | null | undefined) => !!r && /^Rejected(:|$)/.test(r)
interface Lead { timing_note?: string | null; evidence_copy_id?: string | null; evidence_purged_at?: number | null; evidence_origin?: string | null; own_fetch_failure?: string | null; discovered_via?: string | null; discovered_via_link?: string | null; quarantined_at?: number | null; quarantine_reason?: string | null; source_kind?: string | null; contact_context?: {excerpt:string;source_url:string}|null; currentness_held?: boolean; window_held?: boolean; stored_intent?: number | null; stored_why?: string | null; source_check?: {fetch_status:string;quote_match:boolean;company_named:boolean;contact_match:boolean;checked_at:number} | null; sequence?: { status: string; step: number; next_due_at: number | null; stop_reason: string | null } | null; id: string; name: string; company: string; contact: string | null; signal: string; source_url: string; score: number; evidence_excerpt: string | null; event_date: string | null; date_status: string | null; confidence: number | null; review_reason: string | null; company_domain: string | null; human_confirmed_at: number | null; human_confirmed_from: string | null; fit: number | null; intent: number | null; action: number | null; why: string | null; signals: string | null; icp_match: string | null; watch_new?: number; seen_before?: number; stage?: string | null; enrichments?: { connector: string; kind: string; value: string; label: string | null; confidence: number | null; source_url: string; source_date: string; entity_status?: 'heuristic' | 'unconfirmed' | null }[]; events?: { id: string; event_type: string; summary: string; source_url: string; source_published_at: string | null; last_seen_at: number; fresh: boolean; entity_status?: 'heuristic' | 'unconfirmed' | null }[]; priority?: { graded: boolean; fit: number | null; intent: number | null; action: number | null; evidence_score: number; reasons: string[]; uncounted: string[] } | null; lookalike?: { state: 'insufficient' | 'scored'; cohort_size: number; matches: number; matched_on: string[] } | null }
interface Icp { summary: string; who: string[]; industries: string[]; sizes: string[]; where: string[]; signals: string[]; exclude: string[]; country?: string; language?: string; window_days?: number }
interface JobSummary { outcome?: { kind: string; label: string; detail: string; next_step: string }; id: string; status: string; error: string | null; query: string | null; business_name: string; csv_domain: string | null; created_at: number; finished_at: number | null; candidates: number | null; verified: number | null; needs_review: number | null; dropped: number | null; lead_count: number; test_only: boolean }
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
const REVIEW: Record<string, string> = { legacy_currentness_review: 'Legacy research reviewed by you for drafting, not verified current need or consent', event_timing_unconfirmed: 'The quote was found, but its event timing and current need are unconfirmed', event_date_bad_date: 'The claimed event date is invalid - review the source', event_date_stale: 'The claimed event date is outside the freshness window - historical evidence only', event_date_future_date: 'The claimed event date is in the future - current need unconfirmed',  source_review_required: 'Manually supplied claim - literal source checks do not verify its meaning, date, buying need or consent', self_description: 'Text its owner wrote about their own project. This evidence does not establish fit, date or need',  counterparty_signal: 'Names this company as someone else\'s customer - not evidence of its own buying intent', job_closed: 'Source says applications are closed - historical hiring evidence, not an active opening', quote_unconfirmed: 'The saved quote could not be confirmed on the source', location_unconfirmed: 'The source page does not name the place you asked for, so it cannot be tied to a company there - not verified', location_mismatch: 'The source page names a different place than you asked for - possibly a same-name business elsewhere. Not verified', login_required: 'Source requires sign-in - evidence unknown', blocked_by_site: 'The site blocked our check', needs_javascript: 'The page needs JavaScript to show its content', outside_window: 'The event date is older than the time window you asked for - not a current lead', outside_window_undated: 'No event date was found, so it cannot be placed inside the time window you asked for - research only' }

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

// Names of the extra sources a run request carried (the body buildSources made), in the words More sources uses.
const EXTRA_LABEL: Record<string, string> = { github: 'GitHub', youtube: 'YouTube', v2ex: 'V2EX', jobboards: 'Job postings', rss: 'Your feeds', web: 'Your web pages' }
function extraLabels(body: Record<string, unknown> | null): string[] {
  if (!body) return []
  const adapters = Array.isArray(body.adapters) ? body.adapters as string[] : []
  const advanced = Array.isArray(body.advanced) ? body.advanced as string[] : []
  return [...adapters.map(a => EXTRA_LABEL[a] ?? a), ...advanced.map(socialLabel)]
}

// What a scan here can search, and each source it cannot, with the reason and the page that fixes it.
// Capabilities, never a promise: a scan may skip an enabled source (news when another backend already found leads,
// website reads when no lead qualifies), so the entry names what a scan here CAN use. Without an AI key no scan can
// start at all, so that prerequisite comes first. Opt-in social sources are never listed; unavailable core and social
// sources are listed with their reason, and a fix link only where the user can fix it.
function SourceAvailability({ core, social }: { core: SourceRow[] | null; social: SourceRow[] }) {
  if (!core) return <p className="text-xs text-[#555] mt-2" data-testid="source-availability">Could not check which sources are available. Reload to retry.</p>
  const off = [...core, ...social].filter(r => !r.usable)
  const on = usableLabels(core)
  return (
    <div className="text-xs text-[#555] mt-2 space-y-1" data-testid="source-availability">
      <p data-testid="sources-usable">{!core.find(r => r.id === 'research')?.usable
        ? <>A scan cannot start until you add an AI key{on ? <>. Then it can use: {on}</> : ''}.</>
        : on ? <>Sources a scan here can use: {on}. Extra sources are optional, under More sources.</> : <>No source is available for a scan yet.</>}</p>
      {off.length > 0 && <p data-testid="sources-unavailable">Not available: {off.map((r, i) => <span key={r.id} data-testid={`source-off-${r.id}`}>{i > 0 && '; '}{r.label} ({r.reason}{r.fix && <>, <a className="underline text-[#111]" href={r.fix.href}>{r.fix.label}</a></>})</span>)}.</p>}
    </div>
  )
}

export default function LeadsClient() {
  const [query, setQuery] = useState('')
  // The request text of the job being VIEWED (history / deep link): the input must not keep the last typed or restored query
  // of another scan while showing this scan's profile and results (live acceptance run: NYC results under the London query).
  const queryShownFor = useRef<string | null>(null)
  // The job being viewed, readable from async callbacks: a slow "restore the last profile" response must never replace the
  // query or profile of a scan the user is looking at (whichever response arrives first). Synced on every render.
  const viewedJob = useRef('')
  const [draft, setDraft] = useState<Icp | null>(null)
  const [draftNote, setDraftNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [starting, setStarting] = useState(false)
  // Optional per-run spend limit (same budget object as the API; partial, see budget-panel.tsx). Off by default.
  const [budgetForm, setBudgetForm] = useState<BudgetForm>(EMPTY_BUDGET_FORM)
  const budgetCheck = budgetFromForm(budgetForm)
  // The profile shown as "Profile used", with the sentence it was used for (null when unknown).
  const [icp, setIcp] = useState<{ icp: Icp; source: string; query?: string | null } | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  viewedJob.current = jobId ?? ''
  const [status, setStatus] = useState<string>('')
  const [leadsSoFar, setLeadsSoFar] = useState(0)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [createdAt, setCreatedAt] = useState<number | null>(null)
  const [attempt, setAttempt] = useState<[number, number] | null>(null)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  const [cancelNote, setCancelNote] = useState('')
  const [leads, setLeads] = useState<Lead[]>([])
  const [error, setError] = useState('')
  const [quality, setQuality] = useState<Quality | null>(null)
  const [jobError, setJobError] = useState('')
  const [emptyReason, setEmptyReason] = useState<string | null>(null) // why a scan that read pages still extracted nothing (counts only)
  const [outcome, setOutcome] = useState<{ kind: string; label: string; detail: string; next_step: string } | null>(null)
  const [statusError, setStatusError] = useState<'not_found' | 'unavailable' | null>(null)
  const statusFails = useRef(0)
  // Polling resumes a pending scan (a retry or a job reaped after a restart is only picked up by the status poll), so an adopted job is polled normally. ?passive=1 on the URL is the explicit no-kick QA mode: it never starts the runner, but a stale job may still be reaped to pending (not read-only).
  const passiveJob = useRef(false)
  const [useGithub, setUseGithub] = useState(false)
  const [useYoutube, setUseYoutube] = useState(false)
  const [useV2ex, setUseV2ex] = useState(false)
  const [useJobboards, setUseJobboards] = useState(false)
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
  const scanActive = !!jobId && (status === 'pending' || status === 'running')
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
    if (r.ok) setLeads(ls => ls.map(l => l.id === leadId ? { ...l, human_confirmed_at: Math.floor(Date.now() / 1000), human_confirmed_from: l.review_reason ?? 'legacy_currentness_review', review_reason: null, currentness_held: !!l.window_held } : l))
  }
  async function withdrawConfirm(leadId: string) {
    const r = await fetch(`/api/leads/${leadId}/confirm`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' })
    if (r.ok) setLeads(ls => ls.map(l => l.id === leadId ? { ...l, review_reason: l.human_confirmed_from === 'legacy_currentness_review' ? null : l.human_confirmed_from, human_confirmed_at: null, human_confirmed_from: null, currentness_held: l.confidence !== null || !!l.window_held } : l))
  }
  // Quarantine (wrong company / wrong contact details): kept with its evidence, never drafted, sent or exported. Reversible.
  // The lead whose Reject was clicked: its optional reason row is open until confirmed or cancelled.
  const [rejecting, setRejecting] = useState<{ id: string; why: string } | null>(null)
  async function confirmReject() {
    if (!rejecting) return
    const { id, why } = rejecting
    setRejecting(null)
    await quarantine(id, false, rejectReason(why))
  }
  async function quarantine(leadId: string, release = false, reason = 'Wrong company or wrong contact details') {
    const r = await fetch(`/api/leads/${leadId}/quarantine`, { method: release ? 'DELETE' : 'POST', headers: { 'content-type': 'application/json' }, body: release ? '{}' : JSON.stringify({ reason }) })
    if (r.ok) setLeads(ls => ls.map(l => l.id === leadId ? { ...l, quarantined_at: release ? null : Math.floor(Date.now() / 1000), quarantine_reason: release ? null : reason } : l))
  }
  const [contactMsg, setContactMsg] = useState<Record<string, string>>({})
  async function findContact(leadId: string) {
    setContactMsg(m => ({ ...m, [leadId]: 'Searching the company website...' }))
    let msg = 'Could not run the contact search'
    try {
      const r = await fetch(`/api/leads/${leadId}/find-contact`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const j = await r.json().catch(() => ({}))
      if (r.ok) { msg = j.found > 0 ? `Found ${j.found} published contact${j.found === 1 ? '' : 's'} on the company's own pages.` : 'No published contact found on the pages checked. This does not prove none exists.'; await loadLeads() }
      else if (j?.error) msg = String(j.error)
    } catch { /* keep the generic message */ }
    setContactMsg(m => ({ ...m, [leadId]: msg }))
  }
  const [reviewMsg, setReviewMsg] = useState<Record<string, string>>({})
  async function domainReview(leadId: string, action: 'confirm' | 'withdraw', binding?: string | null) {
    let msg = 'Could not save that check'
    try {
      const r = await fetch(`/api/leads/${leadId}/domain-review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, binding }) })
      const j = await r.json().catch(() => ({}))
      if (r.ok) { msg = ''; await loadLeads() } else { if (j?.stale) await loadLeads(); if (j?.error) msg = String(j.error) }
    } catch { /* keep the generic message */ }
    setReviewMsg(m => ({ ...m, [leadId]: msg }))
  }
  // Approve on the card = the existing Draft email action: it creates a draft for review in Outreach and never sends.
  // The server (createDraft) re-checks every identity, quote, date and contact gate.
  // In flight: one request per click burst; after a failure the button comes back so the user can retry.
  const [approving, setApproving] = useState<Record<string, boolean>>({})
  const [approved, setApproved] = useState<Record<string, boolean>>({})
  const approvingRef = useRef<Set<string>>(new Set())
  async function approveLead(leadId: string) {
    if (approvingRef.current.has(leadId)) return
    approvingRef.current.add(leadId); setApproving(a => ({ ...a, [leadId]: true }))
    try { if (await makeDraft(leadId)) { setApproved(a => ({ ...a, [leadId]: true })); void loadScanDrafts() } }
    finally { approvingRef.current.delete(leadId); setApproving(a => ({ ...a, [leadId]: false })) }
  }
  async function makeDraft(leadId: string): Promise<boolean> {
    // Network failure or a non-JSON body (proxy page, server error) must still show a message, never an unhandled rejection.
    let ok = false
    let message = 'Could not create the draft'
    try {
      const r = await fetch('/api/outreach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lead_id: leadId }) })
      ok = r.ok
      const j = await r.json().catch(() => null) as { error?: unknown } | null
      if (!ok && typeof j?.error === 'string' && j.error) message = j.error
    } catch { /* offline or aborted: keep the fixed message */ }
    setDrafted(d => ({ ...d, [leadId]: ok ? 'Draft created from the free template. Review it in Outreach - the AI rewrite there is a separate click that uses your key.' : message }))
    return ok
  }

  // Optional: work out the profile for review before running. The sentence alone runs straight away (submit below).
  async function preview() {
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
  // The account's plan, for showing only the imports it can use. Unknown (load failed) keeps them visible: the server
  // refuses a free account with pro_only either way.
  const [plan, setPlan] = useState<'free' | 'pro' | null>(null)
  // Source availability (what a scan here can search, and why the rest cannot): operator switches, key state, socials.
  const [serverSrc, setServerSrc] = useState<ServerSources | null>(null)
  const [keyState, setKeyState] = useState<KeyState | null>(null)
  const [advanced, setAdvanced] = useState<Advanced | null>(null)
  useEffect(() => { void fetch('/api/usage').then(r => r.ok ? r.json() : null).then(j => { if (j?.plan === 'free' || j?.plan === 'pro') setPlan(j.plan); if (j) setKeyState({ has_key: j.has_key, trial: j.trial }) }).catch(() => {}) }, [])
  useEffect(() => { void fetch('/api/scan/sources').then(r => r.ok ? r.json() : null).then(j => { if (j) setServerSrc(j) }).catch(() => {}) }, [])
  const [advPick, setAdvPick] = useState<string[]>([])
  useEffect(() => { void fetch('/api/settings/advanced').then(r => r.ok ? r.json() : null).then(j => { if (j && Array.isArray(j.platforms)) setAdvanced(j); if (j?.available) setAdvReady(j.platforms.filter((p: { allowed?: boolean; consent: boolean; connected: boolean; enabled: boolean; operator_index?: boolean }) => p.allowed !== false && p.consent && ((p.connected && p.enabled) || p.operator_index)).map((p: { platform: string }) => p.platform)) }).catch(() => {}) }, [])

  // Extra sources this page asked the run for (unknown for a scan adopted after a reload: null).
  const [runExtras, setRunExtras] = useState<string[] | null>(null)
  async function run(withIcp: Icp | null) {
    if (budgetCheck.error) { setError(budgetCheck.error); return } // an enabled but invalid spend limit never starts a run
    setError(''); setStarting(true)
    const srcBody = buildSources({ github: useGithub, youtube: useYoutube, v2ex: useV2ex, jobboards: useJobboards, feedText, pageText, advPick })
    try {
      const r = await fetch('/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, ...(withIcp ? { icp: withIcp } : {}), ...(srcBody ? { sources: srcBody } : {}), ...(budgetCheck.budget ? { budget: budgetCheck.budget } : {}) }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { setError(knownErrorCopy(j.error) ?? (j.error === 'no_api_key' ? 'Add your AI key in Settings first. A scan needs it.' : j.error === 'trial_exhausted' ? 'Your 3 free scans are used up. Add your own AI key in Settings to keep scanning.' : j.error === 'quota_exceeded' ? 'You have used this month\'s scans. Upgrade in Settings.' : j.error || 'Could not start the scan')); if (j.error === 'invalid_budget' && j.detail) setError(`The spend limit was not accepted: ${String(j.detail).slice(0, 200)}`); return }
      setRunExtras(extraLabels(srcBody)); passiveJob.current = false; setJobId(j.job_id); setStatus('pending'); setLeads([]); setQuality(null); setIcp(null); setDraft(null); setLeadsSoFar(0); setStatusError(null); statusFails.current = 0
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
      const r = await fetch(`/api/scan/status?job_id=${jobId}${passiveJob.current ? '&passive=1' : ''}`).catch(() => null)
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
      setStatus(s.status); setOutcome(s.outcome ?? null); setEmptyReason(typeof s.empty_reason === 'string' ? s.empty_reason : null); setJobError(s.error ?? ''); setLeadsSoFar(s.lead_count ?? 0); setStartedAt(s.claimed_at ?? null); setCreatedAt(s.created_at ?? null); setAttempt(s.attempts ? [s.attempts, s.max_attempts ?? 3] : null); setNow(Math.floor(Date.now() / 1000))
      setQuality(s.quality ?? null)
      if (s.icp) setIcp({ icp: s.icp, source: s.icp_source, query: typeof s.query === 'string' ? s.query : null })
      if (typeof s.query === 'string' && s.query && queryShownFor.current !== jobId) { queryShownFor.current = jobId; setQuery(s.query) }
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
  // The Review drafts bar: this scan's unsent emails by state (drafts to review, approved not sent), read back from
  // Outreach so it survives a reload and counts drafts made with Draft email too. Read-only; null when it could not load.
  const [scanDrafts, setScanDrafts] = useState<{ drafts: number; approved: number } | null>(null)
  const loadScanDrafts = async () => {
    const r = await fetch('/api/outreach').catch(() => null)
    const j = r?.ok ? await r.json().catch(() => null) : null
    setScanDrafts(j?.messages ? scanCounts(j.messages, leadIdsRef.current) : null)
  }
  const leadIdsRef = useRef<string[]>([])
  leadIdsRef.current = leads.map(l => l.id)
  const leadKey = leads.map(l => l.id).join(',')
  useEffect(() => { if (leadKey) void loadScanDrafts() }, [leadKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { fetch('/api/crm').then(r => r.ok ? r.json() : null).then(j => setCrmOn(!!j?.configured)).catch(() => {}) }, [])
  const loadWatches = async () => {
    const r = await fetch('/api/watch').catch(() => null)
    if (r?.ok) { const j = await r.json(); setWatches(j.watches ?? []) }
  }
  useEffect(() => { void loadWatches() }, [status])
  // Deep link: /app/leads?job_id=... (watch cards link here to show a past watch run).
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('job_id')
    if (id && /^[a-f0-9]{24}$/.test(id)) { passiveJob.current = new URLSearchParams(window.location.search).get('passive') === '1'; setJobId(id); setStatus('loading') }
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
    void fetch('/api/scan/jobs').then(r => r.ok ? r.json() : null).then(j => { if (j) {
      const jobs: JobSummary[] = j.jobs ?? []
      setPastJobs(jobs)
      // A scan that is still queued/running is the one exception to "nothing autoselects": a reload or a
      // return from Home must show its progress and Stop control, not an enabled Find leads button.
      const active = jobs.find(x => !x.csv_domain && (x.status === 'pending' || x.status === 'running'))
      if (active) { passiveJob.current = new URLSearchParams(window.location.search).get('passive') === '1'; setJobId(active.id); setStatus(active.status) }
    } }).catch(() => {})
  }, [jobId])
  // Restore the last profile so a reload never loses it (item: ICP persistence).
  useEffect(() => {
    if (jobId) return
    void fetch('/api/scan/latest').then(r => r.ok ? r.json() : null).then(j => {
      if (!j) return
      // Either order of responses: a job is being viewed (adopted, or named by the URL) => keep ITS query and profile.
      if (viewedJob.current || /^[a-f0-9]{24}$/.test(new URLSearchParams(window.location.search).get('job_id') ?? '')) return
      if (j.query && !query) setQuery(j.query)
      if (j.icp) setIcp({ icp: j.icp, source: j.icp_source ?? 'user', query: typeof j.query === 'string' ? j.query : null })
    }).catch(() => {})
  }, [])

  // One-sentence play suggestions from the saved business details (examples when there are none). Filling the box is all
  // a click does; the scan starts only from the existing buttons.
  const [plays, setPlays] = useState<PlaySuggestions | null>(null)
  useEffect(() => { void fetch('/api/settings/profile').then(r => r.ok ? r.json() : null).catch(() => null).then(p => setPlays(playSuggestions(p))) }, [])

  const core = coreSources(serverSrc, keyState)

  // Repeating a search: when the sentence is the one a profile YOU reviewed was used for, Find leads runs with that
  // reviewed profile instead of letting the server work out a new one (which silently discarded the review). A changed
  // sentence, or a profile dazl only inferred, still gets a fresh profile; Review profile first always rebuilds it.
  const reuseIcp = icp && icp.source === 'user' && icp.query && icp.query.trim() === query.trim() ? icp.icp : null

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
      {/* Submitting the sentence runs the scan (the server works out the profile, as the run-without-review path always did)
          and lands on live progress; reviewing the profile first is optional. */}
      <form onSubmit={e => { e.preventDefault(); void run(reuseIcp) }} className="mb-4">
        <label htmlFor="play" className="block text-base font-semibold mb-2">Who do you want to reach?</label>
        <textarea id="play" className={`${input} w-full`} rows={3} required minLength={3} maxLength={600} value={query} onChange={e => setQuery(e.target.value)}
          placeholder="One sentence: who, where, and what just happened. e.g. Seed-stage fintech founders in Europe who just hired their first sales rep" />
        {!jobId && plays && <div className="mt-2 space-y-1 text-xs" data-testid="play-suggestions">
          {([['business', 'From your business details:', plays.business], ['examples', 'Examples:', plays.examples]] as const).filter(([, , items]) => items.length > 0).map(([k, label, items]) =>
            <div key={k} className="flex flex-wrap items-center gap-2" data-testid={`play-suggestions-${k}`}>
              <span className="text-[#555]">{label}</span>
              {items.map(t => <button key={t} type="button" data-testid="play-suggestion" onClick={() => setQuery(t)} className="border border-black/20 rounded-full px-3 py-1 text-left hover:border-black">{t}</button>)}
            </div>)}
        </div>}
        <div className="flex gap-3 mt-2 items-center">
          <button disabled={busy || starting || scanActive} title={scanActive ? 'A scan is already running below' : undefined} className="btn-primary">{starting ? 'Starting...' : 'Find leads'}</button>
          <button type="button" disabled={query.trim().length < 3 || busy || starting || scanActive} onClick={() => void preview()} className="text-xs text-[#555] underline disabled:opacity-40 disabled:no-underline">{busy ? 'Working out your profile...' : 'Review profile first'}</button>
        </div>
        {reuseIcp && !scanActive && <p className="text-xs text-[#555] mt-2" data-testid="reuse-profile">Find leads runs with your reviewed profile: {reuseIcp.summary}. Change the sentence, or use Review profile first, to build a new one.</p>}
        {!jobId && <SourceAvailability core={core} social={socialSources(advanced)} />}
      </form>
      <details className="mb-4 text-sm" data-testid="more-sources">
        <summary className="cursor-pointer text-[#555]">More sources</summary>
        <div className="mt-3 space-y-4 border-l border-black/10 pl-4">
          <div className="space-y-2">
            <p className="text-xs font-medium text-[#111]">Add to this search</p>
              <label className="flex items-center gap-2 text-gray-300"><input type="checkbox" checked={useGithub} onChange={e => setUseGithub(e.target.checked)} /> Also search public GitHub repositories</label>
              <label className="flex items-center gap-2 text-gray-300"><input type="checkbox" checked={useYoutube} onChange={e => setUseYoutube(e.target.checked)} /> Also search public YouTube videos</label>
              <label className="flex items-center gap-2 text-gray-300"><input type="checkbox" checked={useV2ex} onChange={e => setUseV2ex(e.target.checked)} /> Also search public V2EX topics</label>
              <label className="flex items-center gap-2 text-gray-300"><input type="checkbox" checked={useJobboards} onChange={e => setUseJobboards(e.target.checked)} /> Also read public job postings (Greenhouse, Ashby, Lever) for a US state in your request</label>
              <label className="block text-xs text-gray-500">Web page URLs to read (https only, one per line, up to 3). Pages are read through Jina Reader, a third-party service: the URLs are sent to it, and it rate limits requests without a key.</label>
              <textarea className={`${input} w-full`} rows={2} value={pageText} onChange={e => setPageText(e.target.value)} placeholder="https://example.com/blog/post" />
              <label className="block text-xs text-gray-500">RSS or Atom feed URLs to include (https only, one per line, up to 5)</label>
              <textarea className={`${input} w-full`} rows={2} value={feedText} onChange={e => setFeedText(e.target.value)} placeholder="https://example.com/news/feed.xml" />
              {advReady.map(p => <label key={p} className="flex items-center gap-2 text-gray-300"><input type="checkbox" checked={advPick.includes(p)} onChange={e => setAdvPick(e.target.checked ? [...advPick, p] : advPick.filter(x => x !== p))} /> {p === "x" ? "Also search X posts (via web index, no account risk)" : `Also search ${socialLabel(p)} (uses operator session, posts may be flagged)`}</label>)}
              <p className="text-xs text-gray-500">Items from these sources are checked against their page like every other lead.</p>
          </div>
          <div>
            <p className="text-xs font-medium text-[#111]">Fill the profile from your website</p>
          <div className="flex gap-2 mt-1 items-center">
            <input type="text" value={siteUrl} onChange={e => setSiteUrl(e.target.value)} maxLength={300} placeholder="Your website - we will fill the profile from it" className={`${input} flex-1`} />
            <button type="button" onClick={() => void fillFromSite()} disabled={siteBusy || siteUrl.trim().length < 5} className="text-gray-400 hover:text-white text-sm px-3 whitespace-nowrap disabled:opacity-40">{siteBusy ? 'Reading your site...' : 'Fill from my website'}</button>
          </div>
          </div>
          <SourceReview />
          <HiringFeed />
          {plan === 'free'
            ? <p className="text-xs text-[#555]" data-testid="pro-sources-note">Bulk domain import and post-commenter import are on the Pro plan. <a className="underline" href="/app/settings#plan">See plans</a></p>
            : <>
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
            </>}
        </div>
      </details>
      {draft && (
        <div className="card p-4 mb-6 text-sm">
          {/* Above BOTH Run buttons: the spend limit and what it does not cover are read before anything starts. */}
          <BudgetPanel form={budgetForm} setForm={setBudgetForm} />
          <div className="flex items-center justify-between gap-3 mb-3">
            <p className="text-gray-400">{draftNote}</p>
            <button onClick={() => run(draft)} disabled={starting || !!budgetCheck.error} className="btn-primary shrink-0 disabled:opacity-40">{starting ? 'Starting...' : 'Run scan with this profile'}</button>
          </div>
          {draft.window_days ? <p className="text-xs text-[#555] mb-2" data-testid="draft-window">Time window for this run: the last {draft.window_days} days</p> : null}
          <label className="block text-xs text-gray-500 mb-1">Who you want</label>
          <textarea className={`${input} w-full mb-2`} rows={2} maxLength={300} value={draft.summary} onChange={e => setDraft({ ...draft, summary: e.target.value })} />
          {([['who', 'Roles or kinds of buyer (one per line)'], ['industries', 'Industries (one per line, empty means any)'], ['sizes', 'Company sizes (one per line, empty means any)'], ['where', 'Where (one per line, empty means anywhere)'], ['signals', 'Buying signals to look for (one per line)'], ['exclude', 'Skip these (one per line)']] as const).map(([k, label]) => (
            <div key={k}>
              <label className="block text-xs text-gray-500 mb-1">{label}</label>
              <textarea className={`${input} w-full mb-2`} rows={2} value={draft[k].join('\n')} onChange={e => setDraft({ ...draft, [k]: lines(e.target.value) })} />
            </div>
          ))}
          <button onClick={() => run(draft)} disabled={starting || !!budgetCheck.error} className="btn-primary disabled:opacity-40">{starting ? 'Starting...' : 'Run scan with this profile'}</button>
        </div>
      )}
      {/* Outside the collapsed profile details: a closed <details> hid the notice and its button (found by the rendered check, test/ui/window-edit.ui.mjs). */}
      {icp && !draft && (<>
        {/* Owner direction (#204): when the user's own constraint excluded results, say so and offer to widen it explicitly - never relax it quietly. */}
        {(() => {
          const wn = windowNotice(leads, icp.icp.window_days)
          if (!wn) return null
          return (
            <p className="text-xs text-[#555] mb-2">
              {wn.text}{' '}
              {wn.editTo && <button className="underline text-[#111]" onClick={() => { setDraft({ ...icp.icp, window_days: wn.editTo! }); setDraftNote(wn.editNote!) }}>{wn.editLabel}</button>}
            </p>
          )
        })()}
        <details className="text-sm text-gray-400 mb-4">
          <summary className="cursor-pointer">Profile used: {icp.icp.summary} <span className="text-gray-600">({icp.source === 'inferred' ? 'worked out by dazl' : icp.source === 'user' ? 'reviewed by you' : 'your words as written'})</span></summary>
          <ul className="mt-2 ml-4 list-disc text-xs">
            {icp.icp.who.length > 0 && <li>Who: {icp.icp.who.join('; ')}</li>}
            {icp.icp.where.length > 0 && <li>Where: {icp.icp.where.join('; ')}</li>}
            {icp.icp.signals.length > 0 && <li>Signals: {icp.icp.signals.join('; ')}</li>}
            {icp.icp.exclude.length > 0 && <li>Skipping: {icp.icp.exclude.join('; ')}</li>}
            {icp.icp.window_days ? <li>Only signals from the last {icp.icp.window_days} days</li> : null}
          </ul>
          <div className="flex items-center gap-3 mt-2">
            <button className="underline text-[#111] text-xs" onClick={() => { setDraft(icp.icp); setDraftNote('Edit the profile and run again.') }}>Edit and run again</button>
            <button className="underline text-[#111] text-xs" onClick={() => void watchReq({ query: query.trim(), icp: icp.icp })}>Watch this weekly</button>
          </div>
          {watchNote && <p className="text-xs text-gray-500 mt-1">{watchNote}</p>}
        </details>
      </>)}
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
            <div>{status === 'pending' ? 'Queued - waiting to start.' : 'Scanning - this can take a few minutes.'}</div>
            <div className="text-gray-400 text-xs">{leadsSoFar > 0 ? `${leadsSoFar} lead${leadsSoFar === 1 ? '' : 's'} so far` : status === 'pending' ? 'Not started' : 'Running'}{status === 'pending' ? (createdAt ? ` - queued ${Math.max(0, Math.floor((now - createdAt) / 60))} min ago` : '') : startedAt ? ` - running ${Math.max(0, Math.floor((now - startedAt) / 60))} min` : ''}{attempt ? ` - attempt ${attempt[0]} of ${attempt[1]}` : ''}</div>
            <div className="text-gray-400 text-xs" data-testid="run-sources">{core ? `Sources this scan can use: ${[usableLabels(core), ...(runExtras ?? [])].filter(Boolean).join(', ') || 'none'}${runExtras === null ? ' (plus any extra sources chosen when it started)' : ''}.` : 'Could not check which sources this scan can use.'}</div>
            <div className="text-gray-400 text-xs">dazl cannot show a per-source count yet. A scan that stops responding is retried automatically, up to {attempt?.[1] ?? 3} attempts.</div>
            <button type="button" className="underline text-[#111] text-xs mt-1" onClick={async () => { const r = await fetch('/api/scan/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ job_id: jobId }) }); const j = await r.json().catch(() => ({})); setCancelNote(r.ok ? (j.note ?? 'Stop requested.') : 'Could not cancel: ' + (j.error ?? 'try again')); if (r.ok) setStatus('failed'); if (r.ok) setJobError('cancelled') }}>Stop this scan</button>
            {cancelNote && <div className="text-gray-400 text-xs">{cancelNote}</div>}
          </div>
        </div>
      )}
      {jobId && status === 'failed' && <p className="text-gray-400 text-sm mb-4">{jobError === 'budget_stopped' ? 'This run stopped because its per-run budget refused the next paid step. That is a budget stop, not an empty search: nothing was concluded about whether leads exist. Run again without that budget control (or with a larger one) to search further.' : jobError === 'cancelled' ? 'Scan stopped. The step that was already running can continue for a while and may still be billed. Its results are discarded and this scan holds its slot for a few minutes.' : jobError === 'scan_timeout' ? 'This scan ran past its time limit and was stopped between steps. Nothing was saved. Steps that already ran may have been billed by your AI provider. Try again with a narrower search.' : jobError === 'no_candidates' ? (emptyReason ? `${emptyReason} This scan did not count toward your monthly scans.` : outcome ? `${outcome.detail} ${outcome.next_step}` : 'No candidates found for that search. Try rephrasing or broadening it - this scan did not count toward your monthly scans.') : jobError === 'trial_key_invalid' ? 'The scan service is having trouble right now. Try again later - this scan did not count toward your free scans.' : jobError === 'key_unreadable' ? KEY_UNREADABLE_COPY.replace(/\.$/, ', then run the scan again.') : 'Scan failed. Try again.'}</p>}
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
      {status === 'done' && outcome && outcome.kind === 'all_rejected' && (
        <p className="text-gray-400 text-sm mb-4" data-outcome="all_rejected">Found, but none qualified: {outcome.detail} {outcome.next_step}</p>
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
                  : j.status === 'failed' ? (j.outcome ? `${j.outcome.label} - ${j.outcome.detail}` : 'failed')
                  : 'still running'}
              </div>
            </a>
          ))}
        </div>
      )}
      {jobId && leads.length > 0 && scanDrafts && barCopy(scanDrafts) && (
        <div className="card p-4 mb-4 flex items-center justify-between gap-3 text-sm" data-testid="approved-bar" role="status">
          <span>{barCopy(scanDrafts)}</span>
          <a className="btn-primary text-xs px-3 py-1.5 shrink-0" href={`/app/outreach?job_id=${jobId}`}>{scanDrafts.drafts > 0 ? 'Review drafts' : 'Open in Outreach'}</a>
        </div>
      )}
      <div className="card divide-y divide-white/5">
        {visibleLeads.length === 0 ? (
          // Loading, failed and status-error states have their own truthful copy above.
          status === 'loading' || status === 'failed' || statusError ? null
            : <p className="p-10 text-center text-gray-500 text-sm">{emptyLeadsMessage(status, 0, hiddenCount, quality?.needs_review) ?? ''}</p>
        ) : visibleLeads.map(l => (
          <div key={l.id} className="p-4 text-sm">
            {(() => {
              const c = leadCardSummary(l, icp && icp.icp.who.length > 0 ? icp.icp.who.join('; ') : '')
              return <div data-testid="lead-card">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium">{l.company_domain ? <a className="underline decoration-black/30" href={`https://${l.company_domain}`} target="_blank" rel="noopener noreferrer nofollow">{c.company}</a> : c.company}{!!l.watch_new && <span className="ml-2 text-[10px] uppercase tracking-wide text-[#111] border border-black/30 px-1 py-0.5">new</span>}</div>
                    <div className="text-[#555] text-xs">{c.contact ?? 'No contact found yet'}</div>
                    {c.contactStatus && <div data-testid="contact-status" className={`text-xs ${c.contactStatus.confirmed ? 'text-[#555]' : 'text-[#111] font-medium border-l-2 border-black pl-2 mt-0.5'}`}>{c.contactStatus.text}</div>}
                  </div>
                  {!l.quarantined_at && <div className="flex gap-2 shrink-0">
                    <button onClick={() => approveLead(l.id)} disabled={!c.approve.ok || !!approving[l.id] || !!approved[l.id]} title={c.approve.ok ? 'Creates a draft for you to review in Outreach. Nothing is sent.' : c.approve.reason} className="btn-primary text-xs px-3 py-1.5">Approve</button>
                    <button onClick={() => setRejecting(rejecting?.id === l.id ? null : { id: l.id, why: '' })} aria-expanded={rejecting?.id === l.id} className="btn-ghost text-xs px-3 py-1.5">Reject</button>
                  </div>}
                </div>
                {rejecting?.id === l.id && !l.quarantined_at && <div className="mt-2 border-l-2 border-black pl-3 text-xs" data-testid="reject-reason">
                  <p className="mb-1">Reject this lead? A reason is optional. It leaves this list; nothing is drafted, sent or exported, and Undo brings it back.</p>
                  <div className="flex flex-wrap gap-1.5 mb-1.5">{REJECT_PRESETS.map(r => <button key={r} type="button" aria-pressed={rejecting.why === r} onClick={() => setRejecting({ id: l.id, why: rejecting.why === r ? '' : r })} className={`border rounded-full px-2 py-0.5 ${rejecting.why === r ? 'border-black bg-black/5' : 'border-black/20'}`}>{r}</button>)}</div>
                  <form className="flex gap-2 items-center" onSubmit={e => { e.preventDefault(); void confirmReject() }}>
                    <input className="field flex-1 text-xs" aria-label="Reason (optional)" placeholder="Reason (optional)" maxLength={120} value={rejecting.why} autoFocus onKeyDown={e => { if (e.key === 'Escape') setRejecting(null) }} onChange={e => setRejecting({ id: l.id, why: e.target.value })} />
                    <button className="btn-primary text-xs px-3 py-1.5">Confirm reject</button>
                    <button type="button" className="underline" onClick={() => setRejecting(null)}>Cancel</button>
                  </form>
                </div>}
                <p className="mt-2">{c.why}</p>
                <p className="text-xs text-[#555] mt-1"><a className="underline" href={c.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">{c.sourceHost}</a> · {c.date}</p>
                {l.quarantined_at
                  ? <p className="text-xs mt-2">{isRejection(l.quarantine_reason) ? l.quarantine_reason : `Quarantined: ${l.quarantine_reason ?? 'by you'}`}. Kept with its evidence; it will not be drafted, sent or exported. <button className="underline" onClick={() => quarantine(l.id, true)}>Undo</button></p>
                  : drafted[l.id] ? <p className="text-xs mt-2" role="status">{drafted[l.id]} {drafted[l.id].startsWith('Draft created') && <a className="underline" href="/app/outreach">Open Outreach</a>}</p>
                  : !c.approve.ok ? <p className="text-xs text-[#555] mt-2">To approve: {c.approve.reason}</p> : null}
              </div>
            })()}
            <details className="mt-2 text-sm">
              <summary className="text-xs text-[#555] cursor-pointer">Details</summary>
              <div className="mt-2">
            {l.sequence && <p className="text-xs text-[#555] mb-2">Sequence: {l.sequence.status} / {l.sequence.step} steps sent{l.sequence.next_due_at ? ` / next due ${new Date(l.sequence.next_due_at * 1000).toLocaleString()}` : ''}{l.sequence.stop_reason ? ` (${l.sequence.stop_reason})` : ''}</p>}
            {!l.quarantined_at && <p className="text-xs mb-1"><button className="underline text-[#555]" onClick={() => quarantine(l.id)}>Quarantine (wrong company or contacts)</button></p>}
<div className="font-medium">{l.company_domain ? <a className="underline decoration-white/30 hover:decoration-white" href={`https://${l.company_domain}`} target="_blank" rel="noopener noreferrer nofollow">{l.company || l.name}</a> : (l.company || l.name)} <span className="text-gray-500">{scoreLabel(l.score, l.fit, l.intent, l.source_kind)}</span>
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
            <OpportunityCardView lead={l} buyerRoles={icp && icp.icp.who.length > 0 ? icp.icp.who.join('; ') : ''} />
            <div className="text-gray-400">{`Saved signal claim: ${l.signal}`}</div>
            {l.why && <div className="text-xs text-gray-300 mt-1">Research rationale: {l.why}</div>}
            {parseSignals(l.signals).length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">{parseSignals(l.signals).map(sg => <span key={sg} className="text-[10px] uppercase tracking-wide text-gray-500 border border-white/10 px-1 py-0.5">{sg.replace(/_/g, ' ')}</span>)}</div>
            )}
            {l.enrichments && l.enrichments.some(e => e.kind === 'contact' || e.kind === 'person') && (() => {
              const people = contactsFromEnrichments(l.enrichments, icp && icp.icp.who.length > 0 ? icp.icp.who.join('; ') : '')
              return (
                <div className="text-xs mt-1 space-y-0.5">
                  <div className="text-gray-500 uppercase tracking-wide text-[10px]">Right people</div>
                  {people.map(p => (
                    <div key={p.name + (p.title ?? '')} className="text-gray-400">
                      <span className="text-[#111]">{p.name}</span>{p.title ? ` - ${p.title}` : ''}{' '}
                      <span className="text-gray-500">via {PEOPLE_SOURCE[p.connector] ?? p.connector}{p.tier === 'strong' ? `, title matches: ${p.matched.join(', ')}` : p.tier === 'weak' ? `, weak title match: ${p.matched.join(', ')}` : ', no title match'}</span>{' '}
                      {p.linkedin && <a className="underline text-[#111]" href={p.linkedin} target="_blank" rel="noopener noreferrer nofollow">profile</a>}
                      {!p.linkedin && p.source && <a className="underline text-[#111]" href={p.source} target="_blank" rel="noopener noreferrer nofollow">source</a>}
                    </div>
                  ))}
                  <div className="text-gray-500">{icp && icp.icp.who.length > 0 ? 'Ordered by title match to your profile - a heuristic. A match is not a verified decision maker or current employee; verify the person before reaching out.' : 'People found for this company - verify the person before reaching out.'}</div>
                </div>
              )
            })()}
            <WarmPath leadId={l.id} company={l.company} signal={l.signal} />
            {l.enrichments && l.enrichments.some(e => e.kind !== 'contact' && e.kind !== 'person' && e.kind !== 'domain_review') && (
              <div className="text-xs mt-1 space-y-0.5">
                {l.enrichments.filter(e => e.kind !== 'contact' && e.kind !== 'person' && e.kind !== 'domain_review').map(e => (
                  <div key={e.kind + e.value} className="text-gray-400">
                    <span className="text-[#111]">{e.kind === 'domain' ? e.value.split('|')[0] : e.value}</span>{e.kind === 'domain' ? ` (${domainBasisText(e)})` : e.label && !e.label.startsWith('contact-context-v1:') ? ` (${dedupeLabel(e.label)})` : ''} <span className="text-gray-500">{e.kind === 'tech' ? 'seen on the company website' : e.connector === 'sitecrawl' ? 'from a company website page' : e.connector === 'hunter' ? 'via Hunter (earlier)' : `via ${e.connector}`}{e.confidence !== null && !e.connector.startsWith('signals:') ? `, ${e.confidence}% confidence` : ''}{e.entity_status === 'unconfirmed' ? ' - entity unconfirmed (name match only), check the source before relying on this' : e.entity_status === 'heuristic' ? ' - entity matched by name only (heuristic, not independently confirmed)' : ''}, seen {e.source_date}</span>{' '}
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
                    <span className="text-gray-500">{/sec\.gov/.test(ev.source_url) ? 'SEC filing' : eventTypeLabel(ev.event_type)}:</span> <span className="text-[#111]">{ev.summary}</span>{' '}
                    <span className="text-gray-500">{ev.source_published_at ? `dated ${ev.source_published_at}, ` : ''}seen {new Date(ev.last_seen_at * 1000).toISOString().slice(0, 10)}{ev.fresh ? ' (dated filing, not buying need)' : ' (event timing unconfirmed or older)'}{ev.entity_status === 'unconfirmed' ? ' - entity unconfirmed (name match only), not used for ranking' : ev.entity_status === 'heuristic' ? ' - name match (heuristic)' : ''}</span>{' '}
                    <a className="underline text-[#111]" href={ev.source_url} target="_blank" rel="noopener noreferrer nofollow">source</a>
                  </div>
                ))}
              </div>
            )}
            {l.evidence_excerpt && <blockquote className="text-gray-500 text-xs border-l border-white/10 pl-3 my-1">{l.human_confirmed_at ? quoteNote(l.source_check?.quote_match).prefix : ''}&ldquo;{l.evidence_excerpt}&rdquo;</blockquote>}
            {l.stored_why && <details className="text-xs my-2"><summary>Saved historical grade (not a currentness verdict; a saved grade may have been made without your offer text and is not rescored)</summary><p>Saved intent: {l.stored_intent ?? 'unknown'}. {l.stored_why}</p></details>}
            {l.window_held && <p className="text-xs border-l-2 border-black pl-3 my-2">Outside the time window you asked for, or its date is unknown - research only. It cannot be drafted or sent, even after you review the source. Run a scan with a wider window to include it.</p>}
            {l.currentness_held && !l.window_held && <p className="text-xs border-l-2 border-black pl-3 my-2">Quote-backed research only - event timing unknown. Fit and contact research can be useful, but no current buying need was verified. Drafting requires your source review.</p>}
            {l.evidence_origin === 'tinyfish_copy' && <p className="text-xs border-l-2 border-black pl-3 my-2" data-testid="evidence-origin">{evidenceOriginLabel(l.evidence_origin, l.own_fetch_failure)}{l.evidence_purged_at ? purgedNote(l.evidence_purged_at) : l.evidence_copy_id ? <> <a className="underline" href={`/api/leads/evidence?lead_id=${l.id}`} target="_blank" rel="noreferrer">View the exact copied text</a></> : ''}</p>}
            {l.timing_note && <p className="text-xs border-l-2 border-black pl-3 my-2" data-testid="timing-note">Researched opportunity - {l.timing_note}</p>}
            <span className="text-gray-500 text-xs mr-3">{l.confidence === null ? (l.human_confirmed_at ? quoteNote(l.source_check?.quote_match).confirmed : 'not verified') : `confidence ${l.confidence}`}{`, ${eventDateCopy(l.event_date, l.date_status)}`}</span>
            {l.human_confirmed_at !== null && l.human_confirmed_at !== undefined && (
              <button onClick={() => withdrawConfirm(l.id)} className="text-gray-600 hover:text-red-400 text-xs mr-3" title={l.human_confirmed_from ? `Was in review: ${REVIEW[l.human_confirmed_from] ?? l.human_confirmed_from}` : undefined}>withdraw confirmation</button>
            )}
            <a className="underline text-[#111] text-xs" href={l.source_url} target="_blank" rel="noopener noreferrer nofollow">source</a>
            <DiscoveredVia l={l} />
            {(() => {
              const pc = publishedContact(l)
              const draftTo = publishedEmail(l)
              return <>
                {pc && pc.purpose !== 'non-sales' && <span className="text-gray-500 text-xs ml-3">{pc.email}{pc.purpose==='unknown'?' - published address; purpose and buyer relevance unknown':' - business inquiry context, not consent'}</span>}
                {pc && (() => { const rv = domainReviewFor(l, l.enrichments)
                  // A contact email that is also the address the crawl recorded is reviewed like a crawled address: equality does not show a cited-page origin.
                  const lc = pc.source === 'lead' && rv.state !== 'not_required'
                  if (pc.source !== 'sitecrawl' && !lc) return null
                  const bpc = lc ? { ...pc, source: 'sitecrawl' as const, domainBasis: rv.basis ?? 'unrecorded' as const, domainBasisSourceUrl: rv.basisSourceUrl } : pc
                  const note = domainBasisNote(bpc) ?? (rv.state === 'not_required' ? null : lc ? 'This address is also the one found by the website crawl.' : 'More than one website is recorded for this company.'); if (!note && rv.state !== 'confirmed') return null
                  const cv = rv.covered
                  return <span className="text-xs ml-3 block mt-1 border border-black px-2 py-1 text-[#111]">
                    {note}{bpc.domainBasisSourceUrl && bpc.domainBasis !== 'unrecorded' ? <> <a className="underline" href={bpc.domainBasisSourceUrl} target="_blank" rel="noopener noreferrer nofollow">{bpc.domainBasis === 'name_probe' ? 'homepage read' : 'page with the link'}</a>.</> : null}
                    {rv.multi && cv && rv.state !== 'not_required' && <span className="block mt-1">One check covers all of these, not only the first: {cv.domains.length} {cv.domains.length === 1 ? 'website' : 'websites'} ({cv.domains.map((d, i) => <span key={'d' + i}>{i ? ', ' : ''}{d.domain}{d.source_url ? <> (<a className="underline" href={d.source_url} target="_blank" rel="noopener noreferrer nofollow">page</a>)</> : null}</span>)}) and {cv.addresses.length} {cv.addresses.length === 1 ? 'address' : 'addresses'} ({cv.addresses.map((a, i) => <span key={'a' + i}>{i ? ', ' : ''}{a.email}{a.source_url ? <> (<a className="underline" href={a.source_url} target="_blank" rel="noopener noreferrer nofollow">page</a>)</> : null}</span>)}).</span>}
                    {rv.state === 'required' && <> A draft needs your check first. <button onClick={() => domainReview(l.id, 'confirm', rv.binding)} className="underline">{rv.multi ? 'These websites are the right company' : 'This website is the right company'}</button> <span className="text-gray-500">(not need, consent or a send approval)</span></>}
                    {rv.state === 'confirmed' && <> You checked that {rv.multi && cv ? `these ${cv.domains.length} websites and ${cv.addresses.length} addresses are` : `${rv.domain} is`} the right company. <button onClick={() => domainReview(l.id, 'withdraw')} className="underline">withdraw</button></>}
                    {reviewMsg[l.id] ? <span className="text-gray-500 ml-2">{reviewMsg[l.id]}</span> : null}
                  </span> })()}
                {pc && pc.purpose === 'non-sales' && <span className="text-gray-500 text-xs ml-3">{pc.email} - published {pc.purposeHint} inbox, not a sales contact</span>}
                {(() => { const n = companySearchEligible(l) ? contactSearchNote(l) : (publishedContact(l) || l.contact ? null : 'No contact stored. This row does not identify a verified company website for contact search.'); return n ? <span className="text-gray-500 text-xs ml-3 block mt-1">{n}</span> : null })()}
                {!pc && !l.contact && l.human_confirmed_at !== null && l.human_confirmed_at !== undefined && companySearchEligible(l) && (
                  <span className="text-xs ml-3 block mt-1"><button onClick={() => findContact(l.id)} className="underline text-[#111]">Look for a published contact on the company website</button>{contactMsg[l.id] ? <span className="text-gray-500 ml-2">{contactMsg[l.id]}</span> : null}</span>
                )}
                {!pc && l.contact && <span className="text-gray-500 text-xs ml-3">{l.contact}</span>}
                {draftTo && domainReviewFor(l, l.enrichments).state !== 'required' && (l.confidence !== null || l.human_confirmed_at !== null) && !(l.fit === 0 && l.intent === null) && (
                  drafted[l.id]
                    ? <span className="text-gray-400 text-xs ml-3">{drafted[l.id]}</span>
                    : l.currentness_held ? <button onClick={()=>confirmReview(l.id)} className="font-mono text-xs border border-black px-2 py-1">I reviewed the source - use for drafting (not consent)</button> : <button onClick={() => void approveLead(l.id)} className="font-mono text-xs uppercase border border-black px-2 py-1 ml-3 hover:bg-black hover:text-white">Draft email</button>)}
              </>
            })()}
            {crmOn && (pushed[l.id]
              ? <span className="text-gray-400 text-xs ml-2">{pushed[l.id]}</span>
              : <button onClick={() => pushCrm(l.id)} className="font-mono text-xs uppercase border border-black px-2 py-1 ml-2 hover:bg-black hover:text-white">Push to CRM</button>)}
              </div>
            </details>
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
                <div className="text-gray-400">{`Saved signal claim: ${l.signal}`}</div>
                <span className="text-[#333] text-xs mr-3">{l.source_kind === 'hiring_feed' && l.review_reason === 'source_review_required' ? 'Saved from a public job posting - literal source checks do not verify its meaning, date, buying need or consent' : (REVIEW[l.review_reason ?? ''] ?? 'Not verified')}</span>
                {l.timing_note && <span className="text-[#333] text-xs mr-3" data-testid="timing-note-review">Researched opportunity - {l.timing_note}.</span>}
                <a className="underline text-[#111] text-xs" href={l.source_url} target="_blank" rel="noopener noreferrer nofollow">source</a>
                <DiscoveredVia l={l} />
                {l.source_check && <div className="text-xs text-[#333] border-l-2 border-black/30 pl-3 my-2">
                  <p>Literal page check: {l.source_check.fetch_status}, checked {new Date(l.source_check.checked_at*1000).toISOString()}. Exact quote: {l.source_check.quote_match?'found':'not found'}. Company named with matching quote: {l.source_check.company_named?'yes':'no'}. Supplied email: {l.source_check.contact_match?'found on page':'not found or not supplied'}.</p>
                  <p>{eventDateCopy(l.event_date,l.date_status)}. No semantic signal verification, fit grade, named buyer, current need or consent.</p>
                </div>}
                {l.source_kind === 'hiring_feed' && <PageSignals leadId={l.id} />}
                {l.source_kind === 'hiring_feed' && <QualifyPreview leadId={l.id} />}
                <button onClick={() => confirmReview(l.id)} className="font-mono text-xs uppercase border border-black px-2 py-1 ml-3 hover:bg-black hover:text-white">I checked this - use it</button>
                {['quote_unconfirmed','source_review_required','event_timing_unconfirmed','event_date_bad_date','event_date_stale','event_date_future_date'].includes(l.review_reason ?? '') && l.evidence_excerpt && (
                  <div className="text-xs text-gray-500 mt-1">{quoteNote(l.source_check?.quote_match).prefix}"{l.evidence_excerpt}"</div>
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
// GDELT's terms require a citation AND a link wherever its results are shown. Used in BOTH lanes (listed leads and the
// "Needs your review" rows): a stale, undated or blocked row is still displayed data. The publisher link is separate.
function DiscoveredVia({ l }: { l: { discovered_via?: string | null; discovered_via_link?: string | null } }) {
  if (!l.discovered_via || !l.discovered_via_link) return null
  return <span className="text-xs text-[#555] ml-2" data-testid="discovered-via">{l.discovered_via} (<a className="underline" href={l.discovered_via_link} target="_blank" rel="noopener noreferrer">gdeltproject.org</a>)</span>
}
