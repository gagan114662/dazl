'use client'
import { PlayOfferCard } from './play-offer'
import { offerFromReply } from '@/lib/play-offer-reply'
import type { PlayOffer } from '@/lib/scan/play-offer-text'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { editedBuyer, journey, showList, type JourneyInput, type JourneyJob, type PreviewLead } from '@/lib/journey'
import { scanCounts } from '@/lib/outreach/scan-drafts'
import { constraintPills, PILLS_SHOWN, playName, playPace, widenActions, type PlayWatch } from '@/lib/play-card'
import { capNotice } from '@/lib/readiness'
import { leadCardSummary } from '@/lib/scan/lead-card'
import { Avatar, Pill, Stepper } from './ui/bits'
import { Icon } from './ui/icons'
import InfoTip from './ui/info-tip'

interface Buyer { summary: string; who: string[]; industries: string[]; sizes: string[]; where: string[]; signals: string[]; exclude: string[] }
interface Profile { website?: string; sells?: string; business_name?: string; buyer?: Buyer | null }
interface PlayIcp extends Partial<Buyer> { window_days?: number }
const EMPTY: Buyer = { summary: '', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] }
const PREVIEW = 3
const POLL_MS = 4000

// Home for every account that has told dazl about its business, new or returning: what dazl understands, the one next
// action for the account's real state, and the current play's opportunities. Read-only except the profile edit, which
// saves through the same POST /api/settings/profile as onboarding. The preview never loosens a gate (lib/journey.ts).
export default function Journey() {
  const [profile, setProfile] = useState<Profile | null | 'failed'>(null)
  const [jobs, setJobs] = useState<JourneyJob[] | null | 'failed'>(null)
  const [playIcp, setPlayIcp] = useState<{ query: string | null; icp: PlayIcp | null } | null>(null)
  const [leads, setLeads] = useState<PreviewLead[] | null>(null)
  const [drafts, setDrafts] = useState<{ drafts: number; approved: number } | null>(null)
  const [editing, setEditing] = useState(false)
  const [capped, setCapped] = useState<string | null>(null)
  // 'loading' until read; null = the list could not be read (the schedule is then unknown, never "Ran once").
  const [watches, setWatches] = useState<PlayWatch[] | null | 'loading'>('loading')
  const [sent, setSent] = useState<number | null>(null)
  const [morePills, setMorePills] = useState(false)
  // What the current play sells (its campaign record, lib/scan/play-offer.ts); undefined until read, null if it has none, 'unreadable' if the read failed or made no sense.
  const [playOfferOf, setPlayOfferOf] = useState<{ id: string; offer: PlayOffer | null | 'unreadable' } | null>(null)

  const get = (u: string) => fetch(u).then(r => r.ok ? r.json() : null).catch(() => null)
  // Missing buyer lists read as empty (never invented), so a partial profile still renders.
  const arr = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  const loadProfile = () => get('/api/settings/profile').then(p => setProfile(p && typeof p === 'object' ? { ...p, buyer: p.buyer && typeof p.buyer === 'object' ? { summary: typeof p.buyer.summary === 'string' ? p.buyer.summary : '', who: arr(p.buyer.who), industries: arr(p.buyer.industries), sizes: arr(p.buyer.sizes), where: arr(p.buyer.where), signals: arr(p.buyer.signals), exclude: arr(p.buyer.exclude) } : null } : 'failed'))
  useEffect(() => {
    void loadProfile()
    void get('/api/scan/jobs').then(j => setJobs(Array.isArray(j?.jobs) ? j.jobs : 'failed'))
    // Why sending stopped stays on screen (not under the collapsed setup details).
    void get('/api/outreach/settings').then(o => setCapped(capNotice(o)))
    void get('/api/scan/latest').then(j => setPlayIcp(j ? { query: j.query ?? null, icp: j.icp ?? null } : null))
    void get('/api/watch').then(w => setWatches(Array.isArray(w?.watches) ? w.watches : null))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const base: JourneyInput = { profile: profile && profile !== 'failed' ? profile : null, jobs: Array.isArray(jobs) ? jobs : null, leads: null, drafts: null }
  const playId = base.profile && base.jobs ? journey(base).play?.id ?? null : null
  const playStatus = base.jobs?.find(j => j.id === playId)?.status
  const playDone = playStatus === 'done'
  const playActive = playStatus === 'pending' || playStatus === 'running' || playStatus === 'enriching'
  // A running play settles into its result here without a refresh: the same read-only jobs list is re-read every few
  // seconds while it is queued, running or finishing, and stops once it is not. A failed re-read keeps the last state.
  useEffect(() => {
    if (!playActive) return
    const t = setInterval(() => { void get('/api/scan/jobs').then(j => { if (Array.isArray(j?.jobs)) setJobs(j.jobs) }) }, POLL_MS)
    return () => clearInterval(t)
  }, [playActive, playId]) // eslint-disable-line react-hooks/exhaustive-deps
  const [stopNote, setStopNote] = useState('')
  // The same Stop as the Leads page: POST /api/scan/cancel for this play only, then re-read the jobs.
  async function stop(id: string) {
    setStopNote('')
    const r = await fetch('/api/scan/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ job_id: id }) }).catch(() => null)
    const j = await r?.json().catch(() => ({}))
    setStopNote(r?.ok ? (j?.note ?? 'Stop requested.') : 'Could not cancel: ' + (j?.error ?? 'try again'))
    if (r?.ok) void get('/api/scan/jobs').then(x => { if (Array.isArray(x?.jobs)) setJobs(x.jobs) })
  }
  useEffect(() => {
    if (!playId) return
    // a failed read is not "no offer": the card says it could not be loaded
    void get(`/api/campaigns/${playId}`).then(c => setPlayOfferOf({ id: playId, offer: offerFromReply(c) }))
  }, [playId]) // eslint-disable-line react-hooks/exhaustive-deps
  // the offer read for the play shown now (an earlier play's read never shows under a newer play)
  const playOffer = playOfferOf && playOfferOf.id === playId ? playOfferOf.offer : undefined
  useEffect(() => {
    if (!playId || !playDone) return
    // The play's own leads, and its own campaign record for drafts (never the account-wide Outreach list).
    void get(`/api/leads?job_id=${playId}`).then(j => {
      const ls: PreviewLead[] | null = Array.isArray(j?.leads) ? j.leads : null
      setLeads(ls)
      if (!ls) return
      void get(`/api/campaigns/${playId}`).then(c => {
        const ok = Array.isArray(c?.messages)
        setDrafts(ok ? scanCounts(c.messages, ls.map(l => l.id)) : null)
        // Contacted = this play's emails that were sent (its own campaign record; unknown when it could not be read).
        const ids = new Set(ls.map(l => l.id))
        setSent(ok ? (c.messages as { lead_id: string; status: string }[]).filter(m => ids.has(m.lead_id) && m.status === 'sent').length : null)
      })
    })
  }, [playId, playDone]) // eslint-disable-line react-hooks/exhaustive-deps

  if (profile === null || jobs === null) return <div className="card p-6 text-sm text-[var(--ink-2)]" data-testid="journey-loading">Loading...</div>
  const j = journey({ ...base, leads, drafts })
  const p = profile !== 'failed' ? profile : null
  const buyer = p?.buyer ?? null

  const icp = playIcp?.icp && j.play && playIcp.query === j.play.query ? playIcp.icp : null
  const pace = j.play && watches !== 'loading' ? playPace(j.play, watches) : null
  const pills = icp ? constraintPills(icp) : []
  const opp = j.split?.opportunities.length ?? null, held = j.split?.review.length ?? null, researchN = j.split?.research.length ?? 0
  const stat = (v: number | null) => v === null ? (j.stage === 'unknown' || j.stage === 'useful' || j.stage === 'all_held' || j.stage === 'research_only' ? '?' : '0') : String(v)
  const missing = p ? [!p.sells && 'what you sell', !buyer?.summary && 'who buys', !buyer?.who.length && 'buyer roles', !buyer?.where.length && 'where they are', !buyer?.sizes.length && 'company size', !buyer?.exclude.length && 'who to skip'].filter((x): x is string => !!x) : []

  return (
    <div className="space-y-4" data-testid="journey" data-stage={j.stage}>
      {capped && <p role="status" data-testid="cap-notice" className="card p-4 text-sm">{capped} <Link className="underline" href="/app/outreach">Outreach</Link></p>}

      {/* The play, as a card: short name, Who / Signal / Pace, status. The full request is behind its (i). */}
      {j.play ? <section className="card p-5 sm:p-6" aria-labelledby="play-name" data-testid="play-card">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs text-[var(--ink-3)]">Play</p>
            <h2 id="play-name" className="text-xl sm:text-2xl font-bold tracking-tight leading-tight mt-0.5"><span data-testid="journey-play">{playName(j.play.query, icp)}</span><InfoTip label="The full request"><span data-testid="play-request">{j.play.query}</span></InfoTip></h2>
          </div>
          {pace && <span className="shrink-0 mt-1" data-testid="play-status" data-status={pace.status}>{pace.status === 'live' || pace.status === 'running' ? <span className={`live-dot ${pace.status === 'running' ? '!text-[var(--lav)]' : ''}`}>{pace.label}</span> : <Pill tone={pace.status === 'failed' ? 'pink' : pace.status === 'paused' ? 'peach' : 'plain'}>{pace.label}</Pill>}</span>}
        </div>
        <dl className="mt-3">
          <div className="kv"><dt>Who</dt><dd>{icp?.who?.length ? icp.who.join(', ') : icp?.summary || <span className="text-[var(--ink-3)]">From your request</span>}</dd></div>
          <div className="kv"><dt>Signal</dt><dd className="flex flex-wrap gap-1.5">{icp?.signals?.length ? icp.signals.slice(0, 3).map(t => <span key={t} className="tag">{t}</span>) : <span className="text-[var(--ink-3)]">From your request</span>}{(icp?.signals?.length ?? 0) > 3 && <span className="tag text-[var(--ink-3)]" data-testid="signals-more">+{icp!.signals!.length - 3}</span>}{typeof icp?.window_days === 'number' && <span className="tag">past {icp.window_days} days</span>}</dd></div>
          <div className="kv"><dt>Pace</dt><dd data-testid="play-pace">{pace ? pace.pace : <span className="text-[var(--ink-3)]">...</span>}</dd></div>
        </dl>
        {j.stage === 'running' && <div className="mt-4"><Stepper steps={[
          { label: 'Read your profile and play', state: j.play.status === 'pending' ? 'live' : 'done', note: j.play.status === 'pending' ? 'Queued' : undefined },
          { label: 'Search and read sources', state: j.play.status === 'running' ? 'live' : j.play.status === 'pending' ? 'todo' : 'done', note: j.play.status === 'running' ? 'Searching...' : undefined },
          { label: 'Check fit and find contacts', state: j.play.status === 'enriching' ? 'live' : 'todo' },
          { label: 'Found leads', state: 'todo' },
        ]} />
          <div className="flex flex-wrap items-center gap-3 mt-3">
            <button type="button" className="btn-ghost btn-sm" onClick={() => void stop(j.play!.id)} data-testid="journey-stop">Stop this scan</button>
            {stopNote && <span className="text-xs text-[var(--ink-2)]" role="status" data-testid="journey-stop-note">{stopNote}</span>}
          </div>
        </div>}
        <div className="flex flex-wrap items-center justify-between gap-3 mt-4 pt-4 border-t border-[var(--line)]">
          <p className="text-sm text-[var(--ink-2)]" data-testid="journey-line">{j.line}</p>
          {j.action && <Link className="btn-primary" href={j.action.href} data-testid="journey-action">{j.action.label}<Icon name="arrow" className="w-4 h-4" /></Link>}
        </div>
      </section>
      : <section className="card p-5 sm:p-6" aria-labelledby="next-heading">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div><p className="text-xs text-[var(--ink-3)]">Next</p><p id="next-heading" className="text-xl font-bold tracking-tight mt-0.5" data-testid="journey-line">{j.line}</p></div>
          {j.action && <Link className="btn-primary btn-lg" href={j.action.href} data-testid="journey-action">{j.action.label}<Icon name="arrow" className="w-4 h-4" /></Link>}
        </div>
      </section>}

      {/* Results first: the counts, then the opportunities; a play with none gets a designed state with real next steps. */}
      {j.play && j.stage !== 'running' && <section className="card p-5 sm:p-6" aria-label="Results" data-testid="journey-results">
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Leads ready" value={stat(opp)} testid="stat-ready" strong />
          <Stat label="Needs your review" value={stat(held)} testid="stat-held" />
          <Stat label="Contacted" value={sent === null ? (j.stage === 'useful' || j.stage === 'all_held' || j.stage === 'research_only' ? '?' : '0') : String(sent)} testid="stat-contacted" />
        </div>
        {j.split && j.split.opportunities.length > 0 ? <ul className="mt-4 divide-y divide-[var(--line)] border-t border-[var(--line)]" aria-label="Opportunities" data-testid="journey-preview">
          {j.split.opportunities.slice(0, PREVIEW).map(l => {
            const c = leadCardSummary(l, buyer?.who.join('; ') ?? '')
            return <li key={l.id} className="py-4 text-sm" data-testid="journey-opportunity">
              <div className="flex items-start gap-3">
                <Avatar name={c.company} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{c.company}</span>{l.fit != null && <Pill tone="plain">fit {l.fit}/5</Pill>}<Pill tone={l.contactReady ? 'mint' : 'plain'} testid="journey-contact">{l.contactReady ? 'Contact ready' : 'No published contact yet'}</Pill></div>
                  {c.contact && <p className="text-xs text-[var(--ink-2)] mt-0.5">{c.contact}</p>}
                  <p className="font-semibold mt-1.5 leading-snug">{c.why}</p>
                  <p className="text-xs mt-2 flex flex-wrap gap-2"><span className="pill pill-plain"><Icon name="link" className="w-3 h-3" />{c.sourceHost}</span><span className="sr-only"> · </span><span className="pill pill-plain"><Icon name="calendar" className="w-3 h-3" />{c.date}</span></p>
                </div>
              </div>
            </li>
          })}
        </ul>
        : (j.stage === 'zero' || j.stage === 'all_held' || j.stage === 'research_only') && <div className="mt-4 rounded-2xl bg-[#f6f0ea] p-5 sm:p-6 text-center" data-testid="journey-empty">
          <p className="text-lg font-bold tracking-tight">{j.stage === 'all_held' ? 'Nothing ready yet - a few leads need your eyes' : j.stage === 'research_only' ? 'Nothing ready - the leads found are research only' : 'No leads ready from this play yet'}</p>
          <p className="text-sm text-[var(--ink-2)] mt-1" data-testid="empty-hint">{j.stage === 'research_only' ? 'None has a verified, dated event, so reviewing them cannot make them ready. To change the result, search again with a different source or signal:' : 'Try a wider version of it:'}</p>
          <div className="flex flex-wrap justify-center gap-2 mt-4">
            {widenActions(j.play.query, icp, j.split && j.split.research.length ? [...new Set(j.split.research.map(r => r.cause))] : undefined).map(a => <Link key={a.testid} className="btn-ghost btn-sm" href={a.href} data-testid={a.testid}>{a.label}</Link>)}
          </div>
        </div>}
        <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
          {j.split && j.split.review.length > 0 && <Link className="btn-ghost btn-sm" href={`/app/leads?job_id=${j.play.id}`} data-testid="journey-held">{j.split.review.length} need{j.split.review.length === 1 ? 's' : ''} your review<InfoTip>Leads where checking the source yourself can settle it. They are never counted as opportunities.</InfoTip></Link>}
          {researchN > 0 && <Link className="btn-ghost btn-sm" href={`/app/leads?job_id=${j.play.id}`} data-testid="journey-research">{researchN} research only<InfoTip>No verified, dated event, outside your time window, or someone else's customer. Reading them is fine; checking them does not make them ready, and they are never counted as opportunities.</InfoTip></Link>}
          {j.split && j.split.opportunities.length > PREVIEW && <Link className="btn-ghost btn-sm" href={`/app/leads?job_id=${j.play.id}`}>All {j.split.opportunities.length} leads</Link>}
          <Link className="btn-ghost btn-sm" href={`/app/outcomes?job_id=${j.play.id}`} data-testid="journey-campaign"><Icon name="check" className="w-3.5 h-3.5" />Drafts and outcomes</Link>
          {drafts && drafts.approved > 0 && <span className="text-xs text-[var(--ink-2)]" data-testid="journey-approved">{drafts.approved} approved, not sent yet</span>}
        </div>
      </section>}

      {/* What dazl understands: only what is set, one nudge for the rest; editable in place. */}
      {p && <section className="card p-5 sm:p-6" aria-labelledby="understand-heading" data-testid="journey-understanding">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h2 id="understand-heading" className="text-lg font-bold tracking-tight">What dazl understands</h2>
          {!editing && <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(true)}>Edit</button>}
        </div>
        {editing ? <ProfileForm profile={p} onDone={saved => { setEditing(false); if (saved) void loadProfile() }} />
          : <>
            <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <Fact k={j.play ? 'Your business profile sells (new plays start from this)' : 'You sell'} v={p.sells} />
              <Fact k="Website" v={p.website} />
              <Fact k="Who buys" v={buyer?.summary} />
              <Fact k="Buyer roles" v={buyer ? showList(buyer.who) : ''} />
              <Fact k="Industries" v={buyer ? showList(buyer.industries) : ''} />
              <Fact k="Where" v={buyer ? showList(buyer.where) : ''} />
              <Fact k="Company size" v={buyer ? showList(buyer.sizes) : ''} />
              <Fact k="Skip" v={buyer ? showList(buyer.exclude) : ''} />
            </dl>
            {missing.length > 0 && <button type="button" className="mt-4 w-full text-left rounded-xl border border-dashed border-[var(--line-2)] px-4 py-3 text-sm hover:border-[var(--ink-3)]" onClick={() => setEditing(true)} data-testid="profile-nudge">
              <span className="font-semibold">Complete your profile</span><span className="text-[var(--ink-2)]"> - add {missing.slice(0, 3).join(', ')}{missing.length > 3 ? ` and ${missing.length - 3} more` : ''}</span>
            </button>}
          </>}
        {j.play && playOffer !== undefined && <div className="mt-4 pt-4 border-t border-[var(--line)]" data-testid="journey-play-offer"><PlayOfferCard jobId={j.play.id} offer={playOffer} onChange={o => setPlayOfferOf({ id: j.play!.id, offer: o })} /></div>}
        {icp && <div className="mt-4 pt-4 border-t border-[var(--line)] text-sm" data-testid="journey-constraints">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-3)] mb-2">This play searched with<InfoTip>The reviewed profile this play ran with, exactly as saved. It is not changed when you edit the business profile above.</InfoTip></p>
          <div className="flex flex-wrap gap-2">
            {pills.map((t, i) => <span key={t.text + i} className={`pill ${t.kind === 'window' ? 'pill-mint' : t.kind === 'skip' ? 'pill-pink' : 'pill-plain'}`} style={i >= PILLS_SHOWN && !morePills ? { display: 'none' } : undefined} data-testid={t.kind === 'window' ? 'journey-window' : undefined}>{t.text}</span>)}
            {pills.length > PILLS_SHOWN && <button type="button" className="pill pill-plain hover:border-[var(--ink-3)]" aria-expanded={morePills} onClick={() => setMorePills(m => !m)} data-testid="pills-more">{morePills ? 'Show less' : `+${pills.length - PILLS_SHOWN} more`}</button>}
          </div>
        </div>}
      </section>}
    </div>
  )
}

function Stat({ label, value, testid, strong }: { label: string; value: string; testid: string; strong?: boolean }) {
  return <div className={`rounded-2xl px-4 py-3 ${strong ? 'bg-[var(--mint-bg)]' : 'bg-[#f6f0ea]'}`} data-testid={testid}>
    <div className="text-3xl font-bold tracking-tight">{value}</div>
    <div className="text-xs text-[var(--ink-2)] mt-0.5">{label}</div>
  </div>
}

// Only what is set is shown; an empty field is left out (the "Complete your profile" nudge covers the rest).
function Fact({ k, v }: { k: string; v?: string | null }) {
  if (!v) return null
  return <div><dt className="text-xs text-[var(--ink-3)]">{k}</dt><dd className="font-medium">{v}</dd></div>
}

function ProfileForm({ profile, onDone }: { profile: Profile; onDone: (saved: boolean) => void }) {
  const b = profile.buyer ?? EMPTY
  const [f, setF] = useState({ sells: profile.sells ?? '', summary: b.summary, who: showList(b.who), industries: showList(b.industries), where: showList(b.where), sizes: showList(b.sizes), signals: showList(b.signals), exclude: showList(b.exclude) })
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  async function save(e: React.FormEvent) {
    e.preventDefault(); setMsg(''); setBusy(true)
    // Untouched fields go back exactly as stored (lib/journey.ts editedBuyer); nothing is broadened, merged or inferred
    // here, and the server validates it.
    const buyer = editedBuyer(b, f)
    const r = await fetch('/api/settings/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sells: f.sells === (profile.sells ?? '') ? profile.sells : f.sells.trim(), buyer }) }).catch(() => null)
    const j = await r?.json().catch(() => ({}))
    setBusy(false)
    if (!r?.ok) return setMsg(j?.error || 'Could not save')
    window.dispatchEvent(new Event('profile-updated'))
    onDone(true)
  }
  const field = (k: keyof typeof f, label: string, hint?: string) => <label className="flex flex-col gap-1 text-sm">{label}{hint && <span className="text-xs text-[var(--ink-3)]">{hint}</span>}<input className="field" aria-label={label} value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })} /></label>
  return <form onSubmit={save} className="grid sm:grid-cols-2 gap-3" data-testid="journey-profile-form">
    {field('sells', 'You sell')}
    {field('summary', 'Who buys')}
    {field('who', 'Buyer roles', 'separate with ;')}
    {field('industries', 'Industries')}
    {field('where', 'Where')}
    {field('sizes', 'Company size')}
    {field('signals', 'Signs they need you now')}
    {field('exclude', 'Skip')}
    <div className="sm:col-span-2 flex items-center gap-3">
      <button className="btn-primary" disabled={busy || f.sells.trim().length < 3 || f.summary.trim().length < 3}>{busy ? 'Saving...' : 'Save'}</button>
      <button type="button" className="btn-ghost" onClick={() => onDone(false)}>Cancel</button>
      {msg && <span className="text-xs" role="alert">{msg}</span>}
    </div>
  </form>
}
