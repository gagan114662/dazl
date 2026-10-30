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
