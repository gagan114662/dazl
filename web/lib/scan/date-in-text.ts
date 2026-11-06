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
// #391: the same calendar day written in Japanese (2026年10月8日), Arabic (٨ أكتوبر ٢٠٢٦) and Hindi (8 अक्टूबर 2026). Arabic-Indic,
// Devanagari and full-width digits are read as digits (a 1:1 swap, so match positions stay those of the original text).
const AR_MON: Record<string, number> = { 'يناير': 1, 'فبراير': 2, 'مارس': 3, 'أبريل': 4, 'ابريل': 4, 'إبريل': 4, 'مايو': 5, 'يونيو': 6, 'يوليو': 7, 'أغسطس': 8, 'اغسطس': 8, 'سبتمبر': 9, 'أكتوبر': 10, 'اكتوبر': 10, 'نوفمبر': 11, 'ديسمبر': 12 }
const HI_MON: Record<string, number> = { 'जनवरी': 1, 'फ़रवरी': 2, 'फरवरी': 2, 'मार्च': 3, 'अप्रैल': 4, 'अप्रेल': 4, 'मई': 5, 'जून': 6, 'जुलाई': 7, 'अगस्त': 8, 'सितंबर': 9, 'सितम्बर': 9, 'अक्टूबर': 10, 'अक्तूबर': 10, 'नवंबर': 11, 'नवम्बर': 11, 'दिसंबर': 12, 'दिसम्बर': 12 }
const ML_MON: Record<string, number> = { ...AR_MON, ...HI_MON }
const ML_NAMES = Object.keys(ML_MON).sort((a, b) => b.length - a.length).join('|')
const DATE_ML = new RegExp([
  '(\\d{4})\\s*年\\s*(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*日',                                     // 2026年10月8日
  `(?<![\\p{L}\\d])(\\d{1,2})\\s+(${ML_NAMES})(?![\\p{L}\\p{M}])[،,]?\\s+(\\d{4})(?!\\d)`,          // 8 أكتوبر 2026, 8 अक्टूबर 2026
  `(?<![\\p{L}\\p{M}])(${ML_NAMES})\\s+(\\d{1,2})[،,]?\\s+(\\d{4})(?!\\d)`,                          // أكتوبر 8، 2026
].join('|'), 'gu')
const asciiDigits = (s: string) => s.replace(/[\u0660-\u0669\u06f0-\u06f9\u0966-\u096f\uff10-\uff19]/g, c => { const n = c.charCodeAt(0); return String(n - (n >= 0xff10 ? 0xff10 : n >= 0x0966 ? 0x0966 : n >= 0x06f0 ? 0x06f0 : 0x0660)) })
function* mlDays(text: string): Generator<{ y: number; m: number; d: number; index: number; end: number }> {
  for (const m of asciiDigits(text).matchAll(DATE_ML)) {
    const at = { index: m.index!, end: m.index! + m[0].length }
    if (m[1]) yield { y: +m[1], m: +m[2], d: +m[3], ...at }
    else if (m[4]) yield { y: +m[6], m: ML_MON[m[5]] ?? 0, d: +m[4], ...at }
    else if (m[7]) yield { y: +m[9], m: ML_MON[m[7]] ?? 0, d: +m[8], ...at }
  }
}
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
  for (const x of mlDays(text.replace(/\s+/g, ' '))) add(x.y, x.m, x.d)
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
  for (const x of mlDays(text)) if (ok(x.y, x.m, x.d)) out.push({ day: `${x.y}-${pad(x.m)}-${pad(x.d)}`, index: x.index, end: x.end })
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
