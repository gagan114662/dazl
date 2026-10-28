'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { journey, type JourneyInput, type JourneyJob, type PreviewLead } from '@/lib/journey'
import { scanCounts } from '@/lib/outreach/scan-drafts'
import { capNotice } from '@/lib/readiness'
import { leadCardSummary } from '@/lib/scan/lead-card'
import { Avatar, Pill, Stepper } from './ui/bits'
import { Icon } from './ui/icons'
import InfoTip from './ui/info-tip'

interface Buyer { summary: string; who: string[]; industries: string[]; sizes: string[]; where: string[]; signals: string[]; exclude: string[] }
interface Profile { website?: string; sells?: string; business_name?: string; buyer?: Buyer | null }
interface PlayIcp extends Partial<Buyer> { window_days?: number }
const EMPTY: Buyer = { summary: '', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] }
const list = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean)
const PREVIEW = 3

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
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const base: JourneyInput = { profile: profile && profile !== 'failed' ? profile : null, jobs: Array.isArray(jobs) ? jobs : null, leads: null, drafts: null }
  const playId = base.profile && base.jobs ? journey(base).play?.id ?? null : null
  const playDone = base.jobs?.find(j => j.id === playId)?.status === 'done'
  useEffect(() => {
    if (!playId || !playDone) return
    // The play's own leads, and its own campaign record for drafts (never the account-wide Outreach list).
    void get(`/api/leads?job_id=${playId}`).then(j => {
      const ls: PreviewLead[] | null = Array.isArray(j?.leads) ? j.leads : null
      setLeads(ls)
      if (!ls) return
      void get(`/api/campaigns/${playId}`).then(c => setDrafts(Array.isArray(c?.messages) ? scanCounts(c.messages, ls.map(l => l.id)) : null))
    })
  }, [playId, playDone]) // eslint-disable-line react-hooks/exhaustive-deps

  if (profile === null || jobs === null) return <div className="card p-6 text-sm text-[var(--ink-2)]" data-testid="journey-loading">Loading...</div>
  const j = journey({ ...base, leads, drafts })
  const p = profile !== 'failed' ? profile : null
  const buyer = p?.buyer ?? null

  return (
    <div className="space-y-4" data-testid="journey" data-stage={j.stage}>
      {capped && <p role="status" data-testid="cap-notice" className="card p-4 text-sm">{capped} <Link className="underline" href="/app/outreach">Outreach</Link></p>}
      {/* The one next action. */}
      <section className="card p-5 sm:p-6" aria-labelledby="next-heading">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-3)]">{j.play ? 'Your current play' : 'Next'}</p>
            {j.play && <h2 className="text-lg font-bold tracking-tight mt-1 leading-snug" data-testid="journey-play">{j.play.query}</h2>}
            <p id="next-heading" className={`${j.play ? 'text-sm mt-1' : 'text-lg font-bold mt-1'}`} data-testid="journey-line">{j.line}</p>
          </div>
          {j.action && <Link className="btn-primary btn-lg shrink-0" href={j.action.href} data-testid="journey-action">{j.action.label}<Icon name="arrow" className="w-4 h-4" /></Link>}
        </div>
        {j.stage === 'running' && j.play && <div className="mt-5"><Stepper steps={[
          { label: 'Read your profile and play', state: j.play.status === 'pending' ? 'live' : 'done', note: j.play.status === 'pending' ? 'Queued' : undefined },
          { label: 'Search and read sources', state: j.play.status === 'running' ? 'live' : j.play.status === 'pending' ? 'todo' : 'done', note: j.play.status === 'running' ? 'Searching...' : undefined },
          { label: 'Check fit and find contacts', state: j.play.status === 'enriching' ? 'live' : 'todo' },
          { label: 'Found leads', state: 'todo' },
        ]} /></div>}
        {j.split && j.split.opportunities.length > 0 && <ul className="mt-5 grid gap-3" aria-label="Opportunities" data-testid="journey-preview">
          {j.split.opportunities.slice(0, PREVIEW).map(l => {
            const c = leadCardSummary(l, buyer?.who.join('; ') ?? '')
            return <li key={l.id} className="rounded-2xl border border-[var(--line)] p-4 text-sm" data-testid="journey-opportunity">
              <div className="flex items-start gap-3">
                <Avatar name={c.company} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{c.company}</span>{l.fit != null && <Pill tone="plain">fit {l.fit}/5</Pill>}<Pill tone={l.contactReady ? 'mint' : 'plain'} testid="journey-contact">{l.contactReady ? 'Contact ready' : 'No published contact yet'}</Pill></div>
                  <p className="font-semibold mt-1.5 leading-snug">{c.why}</p>
                  <p className="text-xs mt-2 flex flex-wrap gap-2"><span className="pill pill-plain"><Icon name="link" className="w-3 h-3" />{c.sourceHost}</span><span className="sr-only"> · </span><span className="pill pill-plain"><Icon name="calendar" className="w-3 h-3" />{c.date}</span></p>
                </div>
              </div>
            </li>
          })}
        </ul>}
        {j.play && (j.split || j.stage === 'failed' || j.stage === 'zero') && <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
          {j.split && j.split.held.length > 0 && <Link className="btn-ghost btn-sm" href={`/app/leads?job_id=${j.play.id}`} data-testid="journey-held">{j.split.held.length} held for review<InfoTip>Leads that need your review, are rejected, undated, outside your time window, or whose company or source is not confirmed. They are never counted as opportunities.</InfoTip></Link>}
          {j.split && j.split.opportunities.length > PREVIEW && <Link className="btn-ghost btn-sm" href={`/app/leads?job_id=${j.play.id}`}>All {j.split.opportunities.length} opportunities</Link>}
          <Link className="btn-ghost btn-sm" href={`/app/campaigns/${j.play.id}`} data-testid="journey-campaign"><Icon name="campaigns" className="w-3.5 h-3.5" />Drafts and outcomes</Link>
          {drafts && drafts.approved > 0 && <span className="text-xs text-[var(--ink-2)]" data-testid="journey-approved">{drafts.approved} approved, not sent yet</span>}
        </div>}
      </section>

      {/* What dazl understands, editable in place. */}
      {p && <section className="card p-5 sm:p-6" aria-labelledby="understand-heading" data-testid="journey-understanding">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h2 id="understand-heading" className="text-lg font-bold tracking-tight">What dazl understands</h2>
          {!editing && <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(true)}>Edit</button>}
        </div>
        {editing ? <ProfileForm profile={p} onDone={saved => { setEditing(false); if (saved) void loadProfile() }} />
          : <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <Fact k="You sell" v={p.sells} />
            <Fact k="Website" v={p.website} />
            <Fact k="Who buys" v={buyer?.summary} />
            <Fact k="Buyer roles" v={buyer?.who.join(', ')} />
            <Fact k="Industries" v={buyer?.industries.join(', ')} empty="Any" />
            <Fact k="Where" v={buyer?.where.join(', ')} empty="Anywhere" />
            <Fact k="Company size" v={buyer?.sizes.join(', ')} empty="Any" />
            <Fact k="Skip" v={buyer?.exclude.join(', ')} empty="Nothing" />
          </dl>}
        {playIcp?.icp && j.play && playIcp.query === j.play.query && <div className="mt-4 pt-4 border-t border-[var(--line)] text-sm" data-testid="journey-constraints">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-3)] mb-2">This play searched with<InfoTip>The reviewed profile this play ran with, exactly as saved. It is not changed when you edit the business profile above.</InfoTip></p>
          <div className="flex flex-wrap gap-2">
            {[...(playIcp.icp.who ?? []), ...(playIcp.icp.industries ?? []), ...(playIcp.icp.where ?? []).map(w => `in ${w}`), ...(playIcp.icp.sizes ?? []), ...(playIcp.icp.signals ?? [])].map(t => <span key={t} className="pill pill-plain">{t}</span>)}
            {typeof playIcp.icp.window_days === 'number' && <span className="pill pill-mint" data-testid="journey-window">past {playIcp.icp.window_days} days</span>}
            {(playIcp.icp.exclude ?? []).map(t => <span key={t} className="pill pill-pink">skip {t}</span>)}
          </div>
        </div>}
      </section>}
    </div>
  )
}

function Fact({ k, v, empty = 'Not set' }: { k: string; v?: string | null; empty?: string }) {
  return <div><dt className="text-xs text-[var(--ink-3)]">{k}</dt><dd className={v ? 'font-medium' : 'text-[var(--ink-3)]'}>{v || empty}</dd></div>
}

function ProfileForm({ profile, onDone }: { profile: Profile; onDone: (saved: boolean) => void }) {
  const b = profile.buyer ?? EMPTY
  const [f, setF] = useState({ sells: profile.sells ?? '', summary: b.summary, who: b.who.join(', '), industries: b.industries.join(', '), where: b.where.join(', '), sizes: b.sizes.join(', '), signals: b.signals.join(', '), exclude: b.exclude.join(', ') })
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  async function save(e: React.FormEvent) {
    e.preventDefault(); setMsg(''); setBusy(true)
    // Every field goes back as shown: nothing is broadened, merged or inferred here; the server validates it.
    const buyer = { summary: f.summary.trim(), who: list(f.who), industries: list(f.industries), where: list(f.where), sizes: list(f.sizes), signals: list(f.signals), exclude: list(f.exclude) }
    const r = await fetch('/api/settings/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sells: f.sells.trim(), buyer }) }).catch(() => null)
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
    {field('who', 'Buyer roles', 'comma separated')}
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
