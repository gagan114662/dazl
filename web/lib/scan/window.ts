// The user's own recency window ("in the past 90 days"). Issue #198: the window was dropped when the request became a
// profile, so nothing enforced it and an April opening came back as a top lead in late October. It is read from the
// request text deterministically (not left to the model), kept on the profile, shown to the user, used in the
// prompts, and enforced on every lead whose event date is known.
// Phrasings: "past/last/previous N days|weeks|months", "within (the last) N ...", "this week|month", and the same
// shapes in pt, es, fr, de, it. These are words for time, not for any business or place.
const UNIT_DAYS: Record<string, number> = {
  day: 1, days: 1, dia: 1, dias: 1, día: 1, días: 1, jour: 1, jours: 1, tag: 1, tage: 1, tagen: 1, giorno: 1, giorni: 1,
  week: 7, weeks: 7, semana: 7, semanas: 7, semaine: 7, semaines: 7, woche: 7, wochen: 7, settimana: 7, settimane: 7,
  month: 30, months: 30, mes: 30, meses: 30, mois: 30, monat: 30, monate: 30, monaten: 30, mese: 30, mesi: 30,
}
const BEFORE = '(?:past|last|previous|within(?:\\s+the)?(?:\\s+(?:past|last))?|últimos|últimas|ultimos|ultimas|derniers|dernières|letzten|vergangenen|ultimi|ultime)'
const AFTER_FR = '(?:derniers|dernières)'
const N_UNIT = new RegExp(`${BEFORE}\\s+(\\d{1,3})\\s+([\\p{L}]+)`, 'iu')
const N_UNIT_FR = new RegExp(`(\\d{1,3})\\s+${AFTER_FR}\\s+([\\p{L}]+)`, 'iu')
const THIS = /\b(?:this|the past|the last)\s+(week|month)\b/i

export const MAX_WINDOW_DAYS = 365
export function parseWindowDays(text: string): number | null {
  for (const re of [N_UNIT, N_UNIT_FR]) {
    const m = re.exec(text)
    const unit = m ? UNIT_DAYS[m[2].toLowerCase()] : undefined
    if (m && unit) return Math.max(1, Math.min(MAX_WINDOW_DAYS, Number(m[1]) * unit))
  }
  const t = THIS.exec(text)
  if (t) return t[1].toLowerCase() === 'week' ? 7 : 30
  return null
}

// Date-only, inclusive: the window covers the cutoff day itself, the same day recencyAnchor tells the model
// ("on or after <cutoff>"). Comparing whole calendar days avoids the noon-vs-midnight mismatch Instinct found (#198).
export const windowCutoff = (windowDays: number, now: Date = new Date()): string => new Date(now.getTime() - windowDays * 86_400_000).toISOString().slice(0, 10)

// A real calendar date in YYYY-MM-DD form (2026-02-30 is not).
const validDate = (d: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false
  const t = Date.parse(`${d}T00:00:00Z`)
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d
}

// Where one event date sits against the window. Only "inside" is actionable for outreach; every other state is
// research only. No window: everything is "inside" (the default 12-month freshness has its own checks).
export type WindowStatus = 'inside' | 'stale' | 'undated' | 'invalid' | 'future'
// The scan's freshness window at read time: the request text wins, else the saved ICP window (#498: shared by the
// leads route and the CSV export so both rule the SAME lead the same way).
export function jobWindowDays(job: { query?: string | null; icp?: string | null }): number | null {
  let icpWindow: number | null = null
  try { const j = job.icp ? JSON.parse(job.icp) as { window_days?: unknown } : null; icpWindow = typeof j?.window_days === 'number' ? j.window_days : null } catch { icpWindow = null }
  return parseWindowDays(job.query ?? '') ?? icpWindow
}

export function windowStatus(eventDate: string | null | undefined, windowDays: number | null | undefined, now: Date = new Date()): WindowStatus {
  if (!windowDays) return 'inside'
  if (!eventDate) return 'undated'
  if (!validDate(eventDate)) return 'invalid'
  if (eventDate > now.toISOString().slice(0, 10)) return 'future'
  return eventDate < windowCutoff(windowDays, now) ? 'stale' : 'inside'
}

// With an explicit window, ONLY a lead whose event date is valid and inside it is actionable. Stale, undated, invalid
// and future dates all leave the scored lane for the review lane with their own reason, so the verified / qualified
// counts never include a lead the hard window gate (outreach/currentness.ts) would hold. Uses windowStatus, the same
// rule as that gate. Nothing is dropped: every moved lead is still stored and counted under needs_review.
export const WINDOW_REVIEW_REASON: Record<Exclude<WindowStatus, 'inside'>, string> = {
  stale: 'outside_window', undated: 'outside_window_undated', invalid: 'event_date_bad_date', future: 'event_date_future_date',
}
export function splitByWindow<T extends { event_date?: string | null }>(leads: T[], windowDays: number | null | undefined, now: Date = new Date()): { inside: T[]; outside: T[]; outsideReasons: string[] } {
  if (!windowDays) return { inside: leads, outside: [], outsideReasons: [] }
  const inside: T[] = []; const outside: T[] = []; const outsideReasons: string[] = []
  for (const l of leads) {
    const st = windowStatus(l.event_date, windowDays, now)
    if (st === 'inside') inside.push(l); else { outside.push(l); outsideReasons.push(WINDOW_REVIEW_REASON[st]) }
  }
  return { inside, outside, outsideReasons }
}
