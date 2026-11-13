// Is a claimed event date actually STATED in the page's text? A date that lives only in page metadata (publication or modified time) or that the
// extraction supplied without the page ever saying it is not a dated event: a re-published archive page would otherwise turn an old event into a
// "recent" verified lead (#460). Pure. Accepted written forms of the same calendar day: 2026-10-08, 2026/10/08, October 8, 2026 (also Oct., ordinals,
// weekday prefix), 8 October 2026, and numeric day/month forms (8/10/2026, 10/8/2026, 8.10.2026).
//
// Numeric day/month order (#780): "08/10/2026" is 8 October in day-first writing and 10 August in month-first writing. The text alone does not say
// which, so neither reading is a stated day. Such a mention is AMBIGUOUS: it is kept (with both readings) so callers can name why it was held, but
// it never proves an event day. It resolves to one reading only on grounded format evidence from the SAME text: another numeric date written with
// the same separator whose first part is over 12 (25/10/2026: day first) or whose second part is over 12 (10/25/2026: month first). When the text
// evidences both orders, or neither, the mention stays ambiguous. Unambiguous forms (ISO, month names, a part over 12, the same number twice) and
// real-calendar validation are unchanged.
const MON = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?'
const MONTH_NO: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const monthNo = (m: string) => MONTH_NO[m.toLowerCase().replace(/\./g, '').slice(0, 3)] ?? 0
const DATE = new RegExp([
  '\\b(\\d{4})[-/](\\d{1,2})[-/](\\d{1,2})\\b',                                         // 2026-10-08, 2026/10/8
  `\\b(${MON})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`,                      // October 8, 2026
  `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MON})\\.?,?\\s+(\\d{4})\\b`,            // 8 October 2026
  '\\b(\\d{1,2})([/.])(\\d{1,2})\\11(\\d{4})\\b',                                         // 8/10/2026, 10/8/2026, 8.10.2026
].join('|'), 'gi')
const ok = (y: number, m: number, d: number) => { const t = new Date(Date.UTC(y, m - 1, d)); return y >= 2000 && y <= 2100 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d }
const pad = (n: number) => String(n).padStart(2, '0')
const iso = (y: number, m: number, d: number) => ok(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null

// One date mention. `day` is the stated day, or null when the mention is ambiguous; `readings` are every valid reading.
export interface DateMention { day: string | null; readings: string[]; ambiguous: boolean; index: number; end: number; text: string }

// The numeric day/month order the text itself evidences, per separator: 'dmy', 'mdy', or null (no evidence, or both).
function numericOrder(text: string): Record<string, 'dmy' | 'mdy' | null> {
  const seen: Record<string, Set<'dmy' | 'mdy'>> = {}
  for (const m of text.matchAll(DATE)) {
    if (!m[10]) continue
    const a = +m[10], b = +m[12], y = +m[13], sep = m[11]
    const s = (seen[sep] ??= new Set())
    if (a > 12 && b <= 12 && ok(y, b, a)) s.add('dmy')
    else if (b > 12 && a <= 12 && ok(y, a, b)) s.add('mdy')
  }
  const out: Record<string, 'dmy' | 'mdy' | null> = {}
  for (const [sep, s] of Object.entries(seen)) out[sep] = s.size === 1 ? [...s][0] : null
  return out
}

// Every date mention with where it sits in `text` (positions are in the text as given).
export function dateMentions(text: string): DateMention[] {
  const order = numericOrder(text)
  const out: DateMention[] = []
  for (const m of text.matchAll(DATE)) {
    const at = { index: m.index!, end: m.index! + m[0].length, text: m[0] }
    const one = (d: string | null) => { if (d) out.push({ day: d, readings: [d], ambiguous: false, ...at }) }
    if (m[1]) one(iso(+m[1], +m[2], +m[3]))
    else if (m[4]) one(iso(+m[6], monthNo(m[4]), +m[5]))
    else if (m[7]) one(iso(+m[9], monthNo(m[8]), +m[7]))
    else if (m[10]) {
      const a = +m[10], b = +m[12], y = +m[13]
      const dmy = iso(y, b, a), mdy = iso(y, a, b)
      const readings = [...new Set([dmy, mdy].filter((d): d is string => !!d))]
      if (readings.length === 0) continue
      if (readings.length === 1) { one(readings[0]); continue }   // a part over 12, or the same number twice: one valid reading
      const o = order[m[11]] ?? null
      if (o === 'dmy') one(dmy)
      else if (o === 'mdy') one(mdy)
      else out.push({ day: null, readings, ambiguous: true, ...at })
    }
  }
  return out
}

// Every calendar day the text states, as YYYY-MM-DD. An ambiguous numeric mention states no day.
export function datesStatedIn(text: string): Set<string> {
  return new Set(dateMentions(text.replace(/\s+/g, ' ')).flatMap(m => m.day ? [m.day] : []))
}
export const dateStatedInText = (isoDay: string, text: string): boolean => datesStatedIn(text).has(isoDay)

// Every stated day with where it sits in the text - used to bind a date to the sentence that states it. Ambiguous numeric mentions
// are included once per reading with ambiguous: true, so a caller can keep their span (sentence splitting) and name why it held.
export function datePositions(text: string): { day: string; index: number; end: number; ambiguous: boolean }[] {
  return dateMentions(text).flatMap(m => m.readings.filter(d => !m.ambiguous ? d === m.day : true).map(day => ({ day, index: m.index, end: m.end, ambiguous: m.ambiguous })))
}

// Years a passage gives for the EVENT it describes: years written as company background - "founded in 2020",
// "incorporated in 2018", "in business since 2015" - say when the company began, not when this event happened, and are
// left out (#460 review). Words that also describe events ("formed", "established", "since") are NOT background: "a joint
// venture formed in 2019" or "an office established in 2019" is the event's own year and stays stale. Used by the stale-year checks (event-date-binding.ts, page-timing.ts).
const BACKGROUND = /\b(?:founded|incorporated|in business since|operating since)\s+(?:in\s+)?$/i
// #1129: a four-digit number written right after an Australian state or territory code is a postcode, never a year
// ("Sydney, NSW 2000 / Melbourne, VIC 3000" held a lead as stale for "the year 2000"). Case-sensitive: the codes are
// written in capitals in addresses, so "sa 2000" or "act 2019" in running text stays a year.
const POSTCODE_BEFORE = /\b(?:NSW|VIC|QLD|SA|WA|TAS|ACT|NT)\s*,?\s*$/
export function eventYears(text: string): number[] {
  const t = text.replace(/\s+/g, ' ')
  return [...t.matchAll(/\b(19[89]\d|20\d{2})\b/g)].filter(m => {
    const before = t.slice(Math.max(0, m.index! - 40), m.index!)
    return !BACKGROUND.test(before) && !POSTCODE_BEFORE.test(before)
  }).map(m => +m[1])
}
