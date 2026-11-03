// The Play card on Home: a short name for a play, its Who / Signal / Pace rows and status, the "searched with" pills,
// and the next actions when a play found nothing useful. Pure and display-only: nothing here runs a scan; an action only
// prefills the Plays box (/app/leads?q=...) for the user to start.
import type { ResearchCause } from './lead-state.ts'
export interface PlayIcp { summary?: string; who?: string[]; industries?: string[]; where?: string[]; sizes?: string[]; signals?: string[]; exclude?: string[]; window_days?: number }
export interface PlayWatch { query: string; active: boolean; next_run_at: number | null; paused_reason: string | null }

const GENERIC = /^(?:independent|small|smaller|growing|local|b2b|smb|mid-?sized|established|new)\s+/i
const SIGNALS: [RegExp, string][] = [
  [/open|new (?:location|office|clinic|site)|second (?:office|location)|expan/i, 'expanding'],
  [/rais|fund|seed|series [a-z]/i, 'just funded'],
  [/hir/i, 'hiring'],
  [/launch/i, 'launching'],
  [/switch|replac|migrat|new (?:software|system|tool)/i, 'switching tools'],
]
const cap = (s: string) => s ? s[0].toUpperCase() + s.slice(1) : s

// "NYC dental practices expanding": place + who + what is happening, from the reviewed profile; the full request stays
// available beside it. Falls back to the first words of the request.
export function playName(query: string | null, icp: PlayIcp | null): string {
  const q = (query ?? '').replace(/\s+/g, ' ').trim()
  const place = icp?.where?.[0]?.split(',')[0]?.trim() ?? ''
  let who = (icp?.summary ?? '').split(/\s+(?:with|that|who|which|in|of)\s+|[,;:(-]/i)[0].trim()
  while (GENERIC.test(who)) who = who.replace(GENERIC, '')
  if (who.split(' ').length > 4) who = who.split(' ').slice(-3).join(' ')
  if (!who) who = icp?.industries?.[0] ? `${icp.industries[0]} companies` : icp?.who?.[0] ?? ''
  const sig = icp?.signals?.[0] ?? q
  const happening = SIGNALS.find(([re]) => re.test(sig))?.[1] ?? ''
  const name = [place, who.toLowerCase(), happening].filter(Boolean).join(' ')
  if (who && name.length <= 48) return cap(name)
  const words = q.split(' ')
  return cap(words.slice(0, 6).join(' ') + (words.length > 6 ? '...' : ''))
}

export type PlayStatus = 'live' | 'paused' | 'running' | 'done' | 'failed'
// Status chip and the Pace row. A weekly watch on the same request makes the play Live (or Paused); with the watch list
// read and none for it, it ran once. `watches === null` means the list could not be read: the schedule is then unknown,
// never reported as one-off (an active weekly play must not read as "Ran once").
export function playPace(job: { status: string; error: string | null; created_at: number; query: string | null }, watches: PlayWatch[] | null): { status: PlayStatus; label: string; pace: string } {
  const w = watches?.find(x => x.query.trim() === (job.query ?? '').trim()) ?? null
  const day = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const unknown = watches === null
  if (job.status === 'pending' || job.status === 'running' || job.status === 'enriching') return { status: 'running', label: 'Running', pace: w ? `Runs weekly${w.active ? '' : ' (paused)'}` : unknown ? `Running now; schedule unavailable` : `Running now, started ${day(job.created_at)}` }
  if (unknown) {
    const last = job.status === 'failed' ? (job.error === 'no_candidates' ? 'No results' : job.error === 'cancelled' ? 'Stopped' : 'Failed') : 'Done'
    return { status: job.status === 'failed' && job.error !== 'no_candidates' ? 'failed' : 'done', label: last, pace: `Last run ${day(job.created_at)}; schedule unavailable` }
  }
  if (w && w.active) return { status: 'live', label: 'Live', pace: `Runs weekly${w.next_run_at ? `, next ${day(w.next_run_at)}` : ''}` }
  if (w) return { status: 'paused', label: 'Paused', pace: `Weekly, paused${w.paused_reason ? ` (${w.paused_reason.replace(/_/g, ' ')})` : ''}` }
  if (job.status === 'failed' && job.error === 'no_candidates') return { status: 'done', label: 'No results', pace: `Ran once, ${day(job.created_at)}` }
  if (job.status === 'failed') return { status: 'failed', label: job.error === 'cancelled' ? 'Stopped' : 'Failed', pace: `Ran once, ${day(job.created_at)}` }
  return { status: 'done', label: 'Ran once', pace: `Ran once, ${day(job.created_at)}` }
}

// Every constraint the play ran with, in a fixed order; the card shows the first few and folds the rest.
export function constraintPills(icp: PlayIcp): { text: string; kind: 'plain' | 'window' | 'skip' }[] {
  return [
    ...(icp.who ?? []).map(t => ({ text: t, kind: 'plain' as const })),
    ...(icp.industries ?? []).map(t => ({ text: t, kind: 'plain' as const })),
    ...(icp.where ?? []).map(t => ({ text: `in ${t}`, kind: 'plain' as const })),
    ...(typeof icp.window_days === 'number' ? [{ text: `past ${icp.window_days} days`, kind: 'window' as const }] : []),
    ...(icp.sizes ?? []).map(t => ({ text: t, kind: 'plain' as const })),
    ...(icp.signals ?? []).map(t => ({ text: t, kind: 'plain' as const })),
    ...(icp.exclude ?? []).map(t => ({ text: `skip ${t}`, kind: 'skip' as const })),
  ]
}
export const PILLS_SHOWN = 6

// Next actions when a play found nothing ready. Each opens Plays with a sentence in the box; nothing starts until Find
// leads. Only a rewrite that is exact is made for the user: the time window's day count is swapped and every other word
// of the request is kept. Place and signal are not rewritten here (a sentence cannot be edited safely by pattern): those
// actions open the full original request for the user to change, and say so.
// `causes` (why the held leads are research only) makes the list reason-aware: widening the window is offered only when
// a dated lead was just too old, never for a missing date; undated or customer-mention leads get a way to change the
// source or signal instead. Omitted, the generic list is kept.
export function widenActions(query: string | null, icp: PlayIcp | null, causes?: ResearchCause[]): { label: string; href: string; testid: string }[] {
  const q = (query ?? '').trim()
  if (!q) return [{ label: 'Write a new play', href: '/app/leads', testid: 'widen-new' }]
  const plays = (s: string) => `/app/leads?q=${encodeURIComponent(s)}`
  const out: { label: string; href: string; testid: string }[] = []
  const days = icp?.window_days
  const inText = /\b(\d+)\s*days?\b/i.exec(q)
  // Only when the request states its window as "<N> days" and N is the saved window: that one number changes.
  if ((!causes || causes.includes('older')) && typeof days === 'number' && days < 180 && inText && Number(inText[1]) === days) out.push({ label: 'Widen to 180 days', href: plays(q.replace(inText[0], `${180} days`)), testid: 'widen-window' })
  out.push({ label: icp?.where?.length ? 'Change the place' : 'Add a place', href: plays(q), testid: 'widen-city' })
  if (causes?.some(c => c === 'undated' || c === 'unsupported' || c === 'closed')) out.unshift({ label: 'Try a signal with dated sources', href: plays(q), testid: 'recover-dated' })
  if ((icp?.signals?.length ?? 0) > 0 || causes?.length) out.push({ label: 'Change the signal', href: plays(q), testid: 'widen-signal' })
  if (causes?.includes('customer')) out.push({ label: 'Search another source', href: plays(q), testid: 'recover-source' })
  return out
}
