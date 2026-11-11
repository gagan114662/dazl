import { playName, type PlayIcp } from './play-card.ts'

// The Plays page: the account's saved, repeating searches (weekly watches, lib/watch.ts, and scheduled monitors,
// lib/monitors.ts) as one list, each with who it looks for, the signal, its schedule, last and next run and status.
// Pure and display-only: it reads the two existing list routes' rows; pausing, resuming and deleting stay on their
// routes, and nothing here runs a scan. A run's leads are results and live in Leads; a play links to its last run there.

export interface WatchRow { id: string; query: string; icp: unknown; active: boolean; next_run_at: number | null; last_run_at: number | null; paused_reason: string | null; last_job_id: string | null; last_status: string | null; new_leads: number; auto?: boolean }
export interface MonitorRow { id: string; query: string; icp?: string | null; interval_hours: number; enabled: number | boolean; paused_reason: string | null; last_run_at: number | null; next_run_at: number | null; last_new_count: number | null; run_count: number; last_job_id?: string | null }

export type PlayTone = 'live' | 'running' | 'paused' | 'failed'
export interface SavedPlay {
  id: string; kind: 'watch' | 'monitor'; name: string; sentence: string
  audience: string | null; signal: string | null; schedule: string
  lastRun: string; lastHref: string | null; nextRun: string
  status: { tone: PlayTone; label: string }; active: boolean
  note: string | null
}

// the reasons the scheduler pauses a play with (lib/watch.ts runDueWatches, lib/monitors.ts runDueMonitors)
const PAUSED: Record<string, string> = {
  no_key: 'Paused: no AI key to run it', no_api_key: 'Paused: no AI key to run it',
  quota: "Paused: this month's scans are used up", quota_exceeded: "Paused: this month's scans are used up",
  trial_used: 'Paused: your free searches are used up. Add your AI key in Settings to keep it running',
}
// #1042: one line under a weekly play about how it repeats and the email after each run
export const AUTO_NOTE = 'dazl set your first play to repeat every week. Pause it any time.'
export const MAIL_NOTE = 'After each run that finds new leads you get an email listing them. Pausing the play stops the runs and the emails.'
export const noteOf = (auto: boolean, emails: boolean): string | null => [auto ? AUTO_NOTE : '', emails ? MAIL_NOTE : ''].filter(Boolean).join(' ') || null

const asIcp = (v: unknown): PlayIcp | null => {
  if (typeof v === 'string') { try { return asIcp(JSON.parse(v)) } catch { return null } }
  return v && typeof v === 'object' ? v as PlayIcp : null
}
const list = (a: unknown) => Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []

// Who: the reviewed profile's summary (or its buyer roles), and where. Null when the play has no profile saved.
export function audienceOf(icp: PlayIcp | null): string | null {
  if (!icp) return null
  const who = (typeof icp.summary === 'string' && icp.summary.trim()) || list(icp.who).join(', ') || list(icp.industries).join(', ')
  const where = list(icp.where).join(', ')
  return [who, where && !who.includes(where) ? where : ''].filter(Boolean).join(' · ') || null
}
export const signalOf = (icp: PlayIcp | null): string | null => list(icp?.signals).join(', ') || null

export function scheduleOf(hours: number): string {
  if (hours % 168 === 0) return hours === 168 ? 'Weekly' : `Every ${hours / 168} weeks`
  if (hours % 24 === 0) return hours === 24 ? 'Daily' : `Every ${hours / 24} days`
  return `Every ${hours} hours`
}

// Dates are instants (unix seconds): shown in the viewer's own time zone unless one is given (tests).
export function dayOf(t: number, timeZone?: string): string {
  return new Date(t * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone })
}
// #1042: when a play last ran and runs next, to the minute ("2 Nov 2026, 15:00"), so "runs every day" is checkable.
export function whenOf(t: number, timeZone?: string): string {
  return new Date(t * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone })
}

// `now` (unix seconds) only decides whether a live play's next run is already due: the scheduler runs it on its next
// check, so the page says so rather than showing a time in the past.
export function savedPlays(watches: WatchRow[] | null, monitors: MonitorRow[] | null, timeZone?: string, now = Math.floor(Date.now() / 1000), emails = false): SavedPlay[] {
  const when = (t: number) => whenOf(t, timeZone)
  const next = (t: number) => t <= now ? 'Due now: runs on the next scheduled check' : whenOf(t, timeZone)
  const out: SavedPlay[] = []
  for (const w of watches ?? []) {
    const icp = asIcp(w.icp)
    const running = w.last_status === 'pending' || w.last_status === 'running' || w.last_status === 'enriching'
    const status: SavedPlay['status'] = !w.active ? { tone: 'paused', label: (w.paused_reason && PAUSED[w.paused_reason]) || 'Paused' }
      : running ? { tone: 'running', label: 'Running now' }
      : w.last_status === 'failed' ? { tone: 'failed', label: 'Live, last run failed' }
      : { tone: 'live', label: 'Live' }
    out.push({
      id: w.id, kind: 'watch', name: playName(w.query, icp), sentence: w.query,
      audience: audienceOf(icp), signal: signalOf(icp), schedule: 'Weekly',
      lastRun: w.last_run_at ? `${when(w.last_run_at)}${w.last_status === 'done' ? `, ${w.new_leads} new` : ''}` : 'Not run yet',
      lastHref: w.last_job_id ? `/app/leads?job_id=${w.last_job_id}` : null,
      nextRun: w.active && w.next_run_at ? next(w.next_run_at) : 'Paused: resume to schedule it',
      status, active: w.active, note: noteOf(w.auto === true, emails),
    })
  }
  for (const m of monitors ?? []) {
    const icp = asIcp(m.icp ?? null), on = m.enabled === true || m.enabled === 1
    out.push({
      id: m.id, kind: 'monitor', name: playName(m.query, icp), sentence: m.query,
      audience: audienceOf(icp), signal: signalOf(icp), schedule: scheduleOf(m.interval_hours),
      lastRun: m.last_run_at ? `${when(m.last_run_at)}${m.last_new_count != null ? `, ${m.last_new_count} new` : ''}` : 'Not run yet',
      lastHref: m.last_job_id ? `/app/leads?job_id=${m.last_job_id}` : null,
      nextRun: on && m.next_run_at ? next(m.next_run_at) : 'Paused: resume to schedule it',
      status: on ? { tone: 'live', label: 'Live' } : { tone: 'paused', label: (m.paused_reason && PAUSED[m.paused_reason]) || 'Paused' },
      active: on, note: null,
    })
  }
  return out
}
