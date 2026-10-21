'use client'
import { useEffect, useState } from 'react'

interface Lead { id: string; name: string; company: string; contact: string | null; signal: string; source_url: string; score: number; evidence_excerpt: string | null; event_date: string | null; date_status: string | null; confidence: number | null; review_reason: string | null; enrichments?: { connector: string; kind: string; value: string; label: string | null; confidence: number | null; source_url: string; source_date: string }[] }
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
  const [useGithub, setUseGithub] = useState(false)
  const [useYoutube, setUseYoutube] = useState(false)
  const [useV2ex, setUseV2ex] = useState(false)
  const [feedText, setFeedText] = useState('')
  const [pageText, setPageText] = useState('')

  const lines = (v: string) => v.split('\n').map(x => x.trim()).filter(Boolean)

  const [drafted, setDrafted] = useState<Record<string, string>>({})
  const [monitors, setMonitors] = useState<{ id: string; query: string; interval_hours: number; enabled: number; paused_reason: string | null; next_run_at: number | null; last_new_count: number | null; run_count: number }[]>([])
  const [monError, setMonError] = useState('')
  const loadMonitors = () => fetch('/api/monitors').then(r => r.ok ? r.json() : null).then(j => { if (j) setMonitors(j.monitors) }).catch(() => {})
  useEffect(() => { void loadMonitors() }, [])
  const addMonitor = async () => {
    setMonError('')
    const r = await fetch('/api/monitors', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: query.trim(), ...(icp ? { icp: icp.icp } : {}) }) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) return setMonError(j.error === 'monitor_limit' ? `Your plan allows ${j.limit} monitors.` : j.error === 'interval_too_short' ? `The shortest interval on your plan is ${j.min} hours.` : j.error || 'Could not create the monitor')
    void loadMonitors()
  }
  const toggleMonitor = async (id: string, enabled: boolean) => { await fetch(`/api/monitors/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) }); void loadMonitors() }
  const removeMonitor = async (id: string) => { await fetch(`/api/monitors/${id}`, { method: 'DELETE' }); void loadMonitors() }
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
    if (!r.ok) return setError(j.error === 'no_api_key' ? 'Add your AI key in Settings first.' : j.error === 'key_rejected' ? 'Your AI key was rejected. Check it in Settings.' : j.error || 'Could not build the profile')
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
    if (!r.ok) return setError(j.error === 'no_api_key' ? 'Add your AI key in Settings first. A scan needs it.' : j.error === 'quota_exceeded' ? 'You have used this month\'s scans. Upgrade in Settings.' : j.error || 'Could not start the scan')
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
      <h1 className="text-2xl font-bold tracking-tight mb-1">Leads</h1>
      <p className="text-gray-400 text-sm mb-6">Buyers showing purchase intent, with the signal and source for each.</p>
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
          <button type="button" disabled={query.trim().length < 3} onClick={addMonitor} className="text-gray-400 hover:text-white text-sm px-3">Monitor this search</button>
        </div>
        {monError && <p className="text-red-400 text-xs mt-2">{monError}</p>}
      </form>
      {draft && (
        <div className="card p-4 mb-6 text-sm">
          <p className="text-gray-400 mb-3">{draftNote}</p>
          <label className="block text-xs text-gray-500 mb-1">Who you want</label>
          <textarea className={`${input} w-full mb-2`} rows={2} maxLength={300} value={draft.summary} onChange={e => setDraft({ ...draft, summary: e.target.value })} />
          {([['who', 'Roles or kinds of buyer (one per line)'], ['where', 'Where (one per line, empty means anywhere)'], ['signals', 'Buying signals to look for (one per line)'], ['exclude', 'Skip these (one per line)']] as const).map(([k, label]) => (
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
      {monitors.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold mb-2">Monitors</h2>
          <p className="text-gray-500 text-xs mb-2">A monitor re-runs its search on a schedule and counts toward your monthly scans. New companies it finds show up here.</p>
          <div className="card divide-y divide-white/5 text-sm">
            {monitors.map(m => (
              <div key={m.id} className="p-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="truncate">{m.query}</div>
                  <div className="text-xs text-gray-500">
                    every {m.interval_hours >= 24 ? `${Math.round(m.interval_hours / 24)}d` : `${m.interval_hours}h`}
                    {m.paused_reason === 'quota' ? ' · paused: monthly scan quota used up' : m.enabled ? (m.next_run_at ? ` · next run ${new Date(m.next_run_at * 1000).toLocaleDateString()}` : '') : ' · paused'}
                    {m.run_count > 0 && ` · ${m.run_count} run${m.run_count === 1 ? '' : 's'}`}
                    {m.last_new_count !== null && m.last_new_count > 0 && <span className="text-[#111]"> · {m.last_new_count} new last run</span>}
                  </div>
                </div>
                <button onClick={() => toggleMonitor(m.id, !m.enabled)} className="text-xs text-gray-400 hover:text-white">{m.enabled ? 'Pause' : 'Resume'}</button>
                <button onClick={() => removeMonitor(m.id)} className="text-xs text-gray-500 hover:text-red-400">Delete</button>
              </div>
            ))}
          </div>
        </div>
      )}
      {jobId && status !== 'done' && <p className="text-gray-400 text-sm mb-4">Scan {status === 'failed' ? 'failed. Try again.' : `${status}... this can take a few minutes.`}</p>}
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
            <div className="font-medium">{l.company || l.name} <span className="text-gray-500">score {l.score}</span></div>
            <div className="text-gray-400">{l.signal}</div>
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
                : <button onClick={() => makeDraft(l.id)} className="font-mono text-xs uppercase border border-black px-2 py-1 ml-3 hover:bg-black hover:text-white">Draft email</button>
            )}
          </div>
        ))}
      </div>
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
