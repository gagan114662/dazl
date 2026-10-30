// Is a claimed event date actually STATED in the page's text? A date that lives only in page metadata (publication or modified time) or that the
// extraction supplied without the page ever saying it is not a dated event: a re-published archive page would otherwise turn an old event into a
// "recent" verified lead (#460). Pure. Accepted written forms of the same calendar day: 2026-10-08, 2026/10/08, October 8, 2026 (also Oct., ordinals,
// weekday prefix), 8 October 2026, and numeric day/month forms (8/10/2026 and 10/8/2026, 8.10.2026): the day is the same whichever order is read.
const MON = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?'
const MONTH_NO: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const monthNo = (m: string) => MONTH_NO[m.toLowerCase().replace(/\./g, '').slice(0, 3)] ?? 0
const DATE = new RegExp([
  '\\b(\\d{4})[-/](\\d{1,2})[-/](\\d{1,2})\\b',                                         // 2026-10-08, 2026/10/8
  `\\b(${MON})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`,                      // October 8, 2026
  `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MON})\\.?,?\\s+(\\d{4})\\b`,            // 8 October 2026
  '\\b(\\d{1,2})[/.](\\d{1,2})[/.](\\d{4})\\b',                                         // 8/10/2026, 10/8/2026, 8.10.2026
].join('|'), 'gi')
const ok = (y: number, m: number, d: number) => { const t = new Date(Date.UTC(y, m - 1, d)); return y >= 2000 && y <= 2100 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d }
const pad = (n: number) => String(n).padStart(2, '0')

// Every calendar day the text states, as YYYY-MM-DD.
export function datesStatedIn(text: string): Set<string> {
  const out = new Set<string>()
  const add = (y: number, m: number, d: number) => { if (ok(y, m, d)) out.add(`${y}-${pad(m)}-${pad(d)}`) }
  for (const m of text.replace(/\s+/g, ' ').matchAll(DATE)) {
    if (m[1]) add(+m[1], +m[2], +m[3])
    else if (m[4]) add(+m[6], monthNo(m[4]), +m[5])
    else if (m[7]) add(+m[9], monthNo(m[8]), +m[7])
    else if (m[10]) { add(+m[12], +m[11], +m[10]); add(+m[12], +m[10], +m[11]) }
  }
  return out
}
export const dateStatedInText = (isoDay: string, text: string): boolean => datesStatedIn(text).has(isoDay)

// Every stated day with where it sits in the (whitespace-normalised) text - used to bind a date to the sentence that states it.
export function datePositions(text: string): { day: string; index: number; end: number }[] {
  const out: { day: string; index: number; end: number }[] = []
  for (const m of text.matchAll(DATE)) {
    const days: string[] = []
    const add = (y: number, mo: number, d: number) => { if (ok(y, mo, d)) days.push(`${y}-${pad(mo)}-${pad(d)}`) }
    if (m[1]) add(+m[1], +m[2], +m[3])
    else if (m[4]) add(+m[6], monthNo(m[4]), +m[5])
    else if (m[7]) add(+m[9], monthNo(m[8]), +m[7])
    else if (m[10]) { add(+m[12], +m[11], +m[10]); add(+m[12], +m[10], +m[11]) }
    for (const day of days) out.push({ day, index: m.index!, end: m.index! + m[0].length })
  }
  return out
}

// Years a passage gives for the EVENT it describes: years written as company background - "founded in 2020",
// "incorporated in 2018", "in business since 2015" - say when the company began, not when this event happened, and are
// left out (#460 review). Words that also describe events ("formed", "established", "since") are NOT background: "a joint
// venture formed in 2019" or "an office established in 2019" is the event's own year and stays stale. Used by the stale-year checks (event-date-binding.ts, page-timing.ts).
const BACKGROUND = /\b(?:founded|incorporated|in business since|operating since)\s+(?:in\s+)?$/i
export function eventYears(text: string): number[] {
  const t = text.replace(/\s+/g, ' ')
  return [...t.matchAll(/\b(19[89]\d|20\d{2})\b/g)].filter(m => !BACKGROUND.test(t.slice(Math.max(0, m.index! - 40), m.index!))).map(m => +m[1])
}
