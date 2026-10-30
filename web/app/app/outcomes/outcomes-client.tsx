'use client'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { currentPlay, type JourneyJob, type PreviewLead } from '@/lib/journey'
import { outcomes, type OutcomeMsg, type RepliesPage } from '@/lib/outcomes'
import { isJobId } from '@/lib/outreach/scan-drafts'
import { scanOutcome } from '@/lib/scan/scan-outcome'
import { Avatar, Pill } from '../ui/bits'
import { Icon } from '../ui/icons'
import InfoTip from '../ui/info-tip'

// Outcomes for one play: what the owner needs to act on, from read-only, play-scoped reads (lib/outcomes.ts). Approving,
// sending, replying, pausing and quarantining stay on their own pages with their checks; this page reports and links.
// ?job_id=<play>, or the current play (the running one, else the newest) when none is given.
export default function OutcomesClient() {
  const q = useSearchParams()
  const asked = q?.get('job_id') ?? null
  const [jobs, setJobs] = useState<JourneyJob[] | null | 'failed'>(null)
  const [leads, setLeads] = useState<PreviewLead[] | null | 'failed'>(null)
  const [messages, setMessages] = useState<OutcomeMsg[] | null | 'failed'>(null)
  const [replies, setReplies] = useState<RepliesPage | null | 'failed'>(null)
  const get = (u: string) => fetch(u).then(r => r.ok ? r.json() : null).catch(() => null)
  useEffect(() => { void get('/api/scan/jobs').then(j => setJobs(Array.isArray(j?.jobs) ? j.jobs : 'failed')) }, [])
  const list = Array.isArray(jobs) ? jobs : []
  const play = isJobId(asked) ? list.find(j => j.id === asked) ?? null : currentPlay(list)
  const id = play?.id ?? null
  useEffect(() => {
    if (!id) return
    void get(`/api/leads?job_id=${id}`).then(j => setLeads(Array.isArray(j?.leads) ? j.leads : 'failed'))
    void get(`/api/campaigns/${id}`).then(c => setMessages(Array.isArray(c?.messages) ? c.messages : 'failed'))
    // This play's conversations that need the owner, filtered and counted on the server (not the newest replies account-wide).
    void get(`/api/outreach/inbox?job_id=${id}&status=needs_owner&limit=100`).then(i => setReplies(Array.isArray(i?.threads) && typeof i?.counts?.needs_owner === 'number'
      ? { threads: i.threads, complete: i.next_cursor === null, needsOwner: i.counts.needs_owner } : 'failed'))
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  const shell = (body: React.ReactNode) => <div className="p-4 sm:p-8 max-w-5xl mx-auto">
    <p className="text-sm mb-3"><Link className="btn-ghost btn-sm" href="/app"><Icon name="home" className="w-3.5 h-3.5" />Home</Link></p>
    <h1 className="text-3xl font-bold tracking-tight">Outcomes</h1>
    {body}
  </div>
  if (jobs === null) return shell(<p className="text-sm text-[var(--ink-2)] mt-4">Loading...</p>)
  if (jobs === 'failed') return shell(<p className="text-sm mt-4" role="alert">Could not load your plays. Reload to retry.</p>)
  if (!play) return shell(<div className="card p-6 mt-5 text-sm" data-testid="outcomes-empty">{isJobId(asked) ? 'This play was not found.' : 'No plays yet.'} <Link className="btn-primary btn-sm ml-2" href="/app/leads">Find leads</Link></div>)

  const o = outcomes({ jobId: play.id, scanFailed: play.status === 'failed' ? scanOutcome({ ...play, empty_reason: play.empty_reason ?? null }).label : null,
    leads: Array.isArray(leads) ? leads : null, messages: Array.isArray(messages) ? messages : null, replies: replies && replies !== 'failed' ? replies : null })
  const loading = leads === null || messages === null || replies === null
  const n = (v: unknown[] | null | undefined, total?: number) => v ? `${total ?? v.length}` : loading ? '...' : '?'
  const leadsHref = `/app/leads?job_id=${play.id}`, outreachHref = `/app/outreach?job_id=${play.id}`

  return shell(<>
    <p className="text-[var(--ink-2)] text-sm mt-1 mb-5" data-testid="outcomes-play">Play: <span className="font-semibold text-[var(--ink)]">{play.query}</span>{(play.status === 'pending' || play.status === 'running' || play.status === 'enriching') && <span className="live-dot ml-2">Running</span>}</p>
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5" data-testid="outcomes-tiles">
      <Tile label="Qualified opportunities" value={n(o.split?.opportunities)} href={leadsHref} testid="tile-opportunities" />
      <Tile label="Drafts to review" value={n(o.drafts)} href={outreachHref} testid="tile-drafts" />
      <Tile label="Conversations need you" value={n(o.conversations?.rows, o.conversations?.total)} href={`/app/inbox?status=needs_owner&job_id=${play.id}`} testid="tile-conversations" />
      <Tile label="Exceptions" value={n(o.exceptions)} href={leadsHref} testid="tile-exceptions" />
    </div>

    <Section title="Conversations that need you" testid="outcomes-conversations" empty="No replies need you." state={o.conversations ? o.conversations.rows.length : null} loading={loading}
      tip={o.conversations && !o.conversations.complete ? `Showing the newest ${o.conversations.rows.length} of ${o.conversations.total}. Open Inbox to see them all.` : 'Interested replies, and replies a person wrote that dazl could not sort. A no, an opt-out or an auto-reply is not listed.'}>
      {o.conversations?.rows.map(r => <Row key={r.gmail_id} name={r.company || r.from_email} sub={r.excerpt} right={<Pill tone={r.classification === 'positive' ? 'mint' : 'lav'}>{r.classification === 'positive' ? 'Interested' : 'Needs a read'}</Pill>} href={`/app/inbox?status=needs_owner&job_id=${play.id}`} />)}
    </Section>

    {/* Approved-but-unsent emails are listed here too (with zero drafts as well): they wait only for their send. */}
    <Section title="Drafts to review" testid="outcomes-drafts" empty="No drafts waiting." state={o.drafts && o.approved ? o.drafts.length + o.approved.length : null} loading={loading} action={o.drafts?.length ? { label: `Review ${o.drafts.length} in Outreach`, href: outreachHref } : null}>
      {o.drafts?.map(m => <Row key={m.id} name={m.to_email} sub={m.subject} right={<Pill tone="peach">Draft</Pill>} href={outreachHref} />)}
      {o.approved?.map(m => <Row key={m.id} name={m.to_email} sub={m.subject} right={<Pill tone="mint">Approved, not sent yet</Pill>} href={outreachHref} />)}
      {o.approved && o.approved.length > 0 && <p className="px-4 py-3 text-xs text-[var(--ink-2)]" data-testid="outcomes-approved">{o.approved.length} approved, not sent yet. {o.sent?.length ?? 0} sent.</p>}
    </Section>

    <Section title="Qualified opportunities" testid="outcomes-opportunities" empty="0 opportunities in this play." state={o.split ? o.split.opportunities.length : null} loading={loading} action={{ label: 'Open leads', href: leadsHref }}>
      {o.split?.opportunities.slice(0, 5).map(l => <Row key={l.id} name={l.company} sub={l.why ?? l.signal} right={<Pill tone={l.contactReady ? 'mint' : 'plain'}>{l.contactReady ? 'Contact ready' : 'No published contact yet'}</Pill>} href={leadsHref} />)}
    </Section>

    <Section title="Exceptions" testid="outcomes-exceptions" empty="Nothing needs attention." state={o.exceptions ? o.exceptions.length : null} loading={loading}
      tip="A scan that failed, an email that failed or may not have sent, and leads held back by a check (they never count as opportunities).">
      {o.exceptions?.map((e, k) => <Row key={k} name={e.text} right={<Pill tone={e.kind === 'held' ? 'grey' : 'pink'}>{e.kind === 'held' ? 'Held' : e.kind === 'send' ? 'Email' : 'Scan'}</Pill>} href={e.href} />)}
    </Section>

    <div className="flex flex-wrap gap-2 mt-6" data-testid="outcomes-secondary">
      <Link className="btn-ghost btn-sm" href={`/app/campaigns/${play.id}`}>Audit trail</Link>
      <Link className="btn-ghost btn-sm" href={leadsHref}>Quarantine or reject leads</Link>
      <Link className="btn-ghost btn-sm" href="/app/settings#autopilot">Pause sending</Link>
    </div>
  </>)
}

function Tile({ label, value, href, testid }: { label: string; value: string; href: string; testid: string }) {
  return <Link href={href} className="card p-4 hover:bg-white transition-colors" data-testid={testid}>
    <div className="text-3xl font-bold tracking-tight">{value}</div>
    <div className="text-xs text-[var(--ink-2)] mt-1">{label}</div>
  </Link>
}
function Section({ title, testid, empty, state, loading, tip, action, children }: { title: string; testid: string; empty: string; state: number | null; loading: boolean; tip?: string; action?: { label: string; href: string } | null; children?: React.ReactNode }) {
  return <section className="card mb-4 overflow-hidden" data-testid={testid}>
    <div className="flex items-center justify-between gap-3 px-4 sm:px-5 pt-4 pb-3">
      <h2 className="text-base font-bold tracking-tight">{title}{tip && <InfoTip>{tip}</InfoTip>}</h2>
      {action && <Link className="btn-ghost btn-sm" href={action.href}>{action.label}</Link>}
    </div>
    <div className="border-t border-[var(--line)] divide-y divide-[var(--line)]">
      {state === null ? <p className="px-4 sm:px-5 py-3 text-sm text-[var(--ink-2)]">{loading ? 'Loading...' : 'Could not load this. Reload to retry.'}</p>
        : state === 0 ? <p className="px-4 sm:px-5 py-3 text-sm text-[var(--ink-2)]">{empty}</p> : children}
    </div>
  </section>
}
function Row({ name, sub, right, href }: { name: string; sub?: string; right: React.ReactNode; href: string }) {
  return <Link href={href} className="flex items-center gap-3 px-4 sm:px-5 py-3 text-sm hover:bg-white transition-colors">
    <Avatar name={name} size={32} />
    <span className="min-w-0 flex-1"><span className="block font-medium truncate">{name}</span>{sub && <span className="block text-xs text-[var(--ink-2)] truncate">{sub}</span>}</span>
    <span className="shrink-0">{right}</span>
  </Link>
}
