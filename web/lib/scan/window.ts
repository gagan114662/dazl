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

// Leads whose known event date is older than the window: moved to the review lane with a dated reason, never returned
// as a scored lead. Undated leads are left as they are (the grader and the date label already say "undated").
export function splitByWindow<T extends { event_date?: string | null }>(leads: T[], windowDays: number | null | undefined, now: Date = new Date()): { inside: T[]; outside: T[] } {
  if (!windowDays) return { inside: leads, outside: [] }
  const cutoff = now.getTime() - windowDays * 86_400_000
  const inside: T[] = []; const outside: T[] = []
  for (const l of leads) {
    const t = l.event_date && /^\d{4}-\d{2}-\d{2}$/.test(l.event_date) ? Date.parse(`${l.event_date}T00:00:00Z`) : NaN
    if (Number.isFinite(t) && t < cutoff) outside.push(l); else inside.push(l)
  }
  return { inside, outside }
}
