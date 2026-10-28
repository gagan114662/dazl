import type { ReadinessInput } from './readiness.ts'
import { coreSources, socialSources } from './scan/source-availability.ts'
import { sourceName } from './source-progress-copy.ts'
import type { SourceProgress } from './scan/progress.ts'

// The five-step path on Home (website -> brain -> first play run -> first lead approved -> first draft sent), read from
// the same tenant responses as the full setup checklist (lib/readiness.ts). Pure and client-safe. A step is done only on
// positive evidence; a read that failed, or a capped read that found nothing, is "unknown", never a to-do or a tick.

export type StepId = 'website' | 'brain' | 'play' | 'approved' | 'sent'
export interface Step { id: StepId; label: string; state: 'done' | 'todo' | 'unknown'; detail: string; href: string; action: string; next?: boolean }

// The reads' caps, as in lib/readiness.ts: a list this long may be missing older history.
const MESSAGES_CAP = 200, CAMPAIGNS_CAP = 10, JOBS_CAP = 20
const host = (w: string) => w.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')

export function homeSteps(i: ReadinessInput): Step[] {
  const p = i.profile
  const website: Step = !p ? { id: 'website', label: 'Website added', state: 'unknown', detail: 'could not check - your profile did not load', href: '/app?setup=site', action: 'Add website' }
    : p.website ? { id: 'website', label: 'Website added', state: 'done', detail: host(p.website), href: '/app?setup=site', action: 'Change' }
    : { id: 'website', label: 'Website added', state: 'todo', detail: 'the only thing you type: dazl reads the rest from it', href: '/app?setup=site', action: 'Add website' }
  const b = p?.buyer
  const brain: Step = !p ? { id: 'brain', label: 'Brain built', state: 'unknown', detail: 'could not check - your profile did not load', href: '/app?setup=brain', action: 'Build' }
    : b && ((b.who?.length ?? 0) > 0 || !!b.summary?.trim()) ? { id: 'brain', label: 'Brain built', state: 'done', detail: b.summary?.trim() || (b.who ?? []).join(', '), href: '/app?setup=brain', action: 'Edit' }
    : { id: 'brain', label: 'Brain built', state: 'todo', detail: 'who buys from you, drafted from your website', href: '/app?setup=brain', action: 'Build' }

  // Only searches the account wrote itself; imports and test fixtures are not plays.
  const own = i.jobs?.filter(j => j.query && !j.csv_domain && !j.test_only) ?? []
  const finished = own.filter(j => j.status === 'done').sort((a, c) => c.created_at - a.created_at)
  const running = own.find(j => ['pending', 'running', 'enriching'].includes(j.status))
  const finishedCount = Math.max(i.totals?.finished ?? 0, finished.length)
  const listFull = (i.jobs?.length ?? 0) >= JOBS_CAP
  const latest = finished[0]
  const play: Step = !i.jobs && !i.totals ? { id: 'play', label: 'First play run', state: 'unknown', detail: 'could not check - your searches did not load', href: '/app/leads', action: 'Open plays' }
    : finishedCount > 0 ? { id: 'play', label: 'First play run', state: 'done', detail: `${finishedCount} finished${latest?.query ? `; latest: ${latest.query}` : ''}`, href: latest ? `/app/leads?job_id=${latest.id}` : '/app/leads', action: 'See leads' }
    : running ? { id: 'play', label: 'First play run', state: 'todo', detail: 'running now', href: `/app/leads?job_id=${running.id}`, action: 'Watch it live' }
    : !i.totals && listFull ? { id: 'play', label: 'First play run', state: 'unknown', detail: `could not check - only your latest ${JOBS_CAP} scans could be checked`, href: '/app/leads', action: 'Open plays' }
    : { id: 'play', label: 'First play run', state: 'todo', detail: 'pick a play and dazl finds the first leads', href: '/app/leads', action: 'Run a play' }

  // Approving a lead makes its draft, so a draft (or an approved or sent email) is the evidence. Both reads are capped:
  // finding one proves it; finding none proves nothing unless the read was complete.
  const msgs = i.messages ?? null, camps = i.campaigns ?? null
  const msgsComplete = !!msgs && msgs.length < MESSAGES_CAP, campsComplete = !!camps && camps.length < CAMPAIGNS_CAP
  const made = (msgs ? msgs.filter(m => m.status !== 'skipped').length : 0) + (camps ? camps.reduce((n, c) => n + (c.outreach ? c.outreach.drafts + c.outreach.approved + c.outreach.sent : 0), 0) : 0)
  const sentN = (msgs ? msgs.filter(m => m.status === 'sent').length : 0)
  const campSent = camps ? camps.reduce((n, c) => n + (c.outreach?.sent ?? 0), 0) : 0
  const gap = (what: Array<string | false>) => `could not check - ${what.filter(Boolean).join(' and ')}`
  const reviewHref = latest ? `/app/leads?job_id=${latest.id}` : '/app/leads'
  const approved: Step = made > 0 ? { id: 'approved', label: 'First lead approved', state: 'done', detail: `${made} draft${made === 1 ? '' : 's'} made from approved leads`, href: '/app/outreach', action: 'Open drafts' }
    : !msgsComplete || !campsComplete ? { id: 'approved', label: 'First lead approved', state: 'unknown', detail: gap([!msgs ? 'your emails did not load' : !msgsComplete && `only your latest ${MESSAGES_CAP} emails could be checked`, !camps ? 'your campaigns did not load' : !campsComplete && `only your latest ${CAMPAIGNS_CAP} searches could be checked`]), href: reviewHref, action: 'Review leads' }
    : { id: 'approved', label: 'First lead approved', state: 'todo', detail: 'approve a lead and dazl drafts the message', href: reviewHref, action: 'Review leads' }
  const sentTotal = Math.max(sentN, campSent)
  const sent: Step = sentTotal > 0 ? { id: 'sent', label: 'First draft sent', state: 'done', detail: `${sentTotal} sent from your Gmail`, href: '/app/outreach', action: 'Open Outreach' }
    : !msgsComplete ? { id: 'sent', label: 'First draft sent', state: 'unknown', detail: gap([!msgs ? 'your emails did not load' : `only your latest ${MESSAGES_CAP} emails could be checked`]), href: '/app/outreach', action: 'Open Outreach' }
    : { id: 'sent', label: 'First draft sent', state: 'todo', detail: made > 0 ? 'a draft is waiting: approve its exact text and send' : 'you approve the exact text; it goes from your own Gmail', href: '/app/outreach', action: 'Open Outreach' }

  const steps = [website, brain, play, approved, sent]
  const n = steps.find(s => s.state === 'todo')
  if (n) n.next = true
  return steps
}

// Which sources to name on Home, and only truthful ones: those that ran in the latest finished play (from its recorded
// per-source progress; skipped, switched-off, failed and unfinished rows left out), else those a scan here can use now (configured and keyed).
// Sources that cannot run are not listed here; the full setup checklist explains them. null = nothing could be checked.
export function homeSources(i: ReadinessInput, lastRun: SourceProgress[] | null): { basis: 'ran' | 'ready'; names: string[] } | null {
  if (lastRun) {
    const names = [...new Set(lastRun.filter(r => r.state === 'done' && r.status !== 'skipped' && r.status !== 'unavailable').map(r => sourceName(r.source)))]
    if (names.length) return { basis: 'ran', names }
  }
  const core = coreSources(i.sources ?? null, i.usage ? { has_key: i.usage.has_key, trial: i.usage.trial } : null)
  if (!core) return null
  // Without a usable AI key no scan can start, so no source is ready.
  if (!core.find(r => r.id === 'research')?.usable) return { basis: 'ready', names: [] }
  return { basis: 'ready', names: [...core, ...socialSources(i.advanced ?? null)].filter(r => r.usable).map(r => r.label) }
}
