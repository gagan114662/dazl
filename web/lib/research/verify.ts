// MISSION v2, part D (Refs #1099): stage 7 of the research engine, ported from ~/work/proto/ai-research (pipeline.py verify(), lib.py
// quote_in / window / date_tokens_ok) - and made stricter where the prototype was loose. A lead is READY only when every claim it shows is
// proven on a page that was opened:
//   - the event: its quote appears contiguously on the opened page (no "any 8-word window" tolerance), and a second model, reading the
//     passage around it, agrees the passage supports the stated fact;
//   - the day: the date quote appears on that page and names that day (month and day, or month and year); a relative date ("3 days ago")
//     counts only for days and weeks, computed from when the page was read; the day is inside the window (90 days by default) and not ahead;
//   - the person: their quote appears on the page they were found on, the quote's passage names their surname, and the second model agrees
//     the passage shows them in a senior role at THIS business;
//   - every proof keeps its source URL (the citations the lead card shows).
// The second model is injected (`decide`): the free Decider on OpenRouter when reachable, a Claude model that did not write the claim
// otherwise (part C owns that client). Nothing here calls a network.
import { norm } from '../scan/evidence.ts'

export type Decide = (state: Record<string, unknown>, questions: Record<string, { type: 'noul'; instructions: string }>) => Promise<{ [k: string]: number | null | undefined } | null>
export const WINDOW_DAYS = 90
export const SUPPORT_MIN = 0.5   // the second model's probability that the passage supports the claim

const flat = (s: string) => norm((s ?? '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-'))
  .replace(/\.(?= |$)/g, '')   // a word-ending full stop is sentence punctuation (a headline has none): never part of the words compared
const trimEllipsis = (s: string) => s.replace(/^\s*(?:\.{3,}|…)+\s*/, '').replace(/\s*(?:\.{3,}|…)+\s*$/, '')

// The quote, normalised, appears contiguously in the page text, normalised. At least 4 words. An ellipsis at either end only marks a cut;
// one inside the quote (words skipped) makes it fail, as in the old engine's verifier.
export function quoteOnPage(quote: string, pageText: string, minWords = 4): boolean {
  const q = flat(trimEllipsis(quote)), t = flat(pageText)
  return q.split(' ').filter(Boolean).length >= minWords && t.includes(q)
}

// The text around where a quote sits on the page (what the second model reads). '' when the quote is not on the page.
export function passageAround(quote: string, pageText: string, pad = 450): string {
  const words = flat(trimEllipsis(quote)).split(' ').filter(Boolean).slice(0, 6)
  if (words.length === 0) return ''
  const re = new RegExp(words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\W_]+'), 'i')
  const m = re.exec(pageText.normalize('NFKD').replace(/[̀-ͯ]/g, ''))
  return m ? pageText.slice(Math.max(0, m.index - pad), m.index + m[0].length + pad) : ''
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MONTHS_DE = ['jan', 'feb', 'marz', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dez']
const MONTHS_FR = ['janv', 'fevr', 'mars', 'avr', 'mai', 'juin', 'juil', 'aout', 'sept', 'oct', 'nov', 'dec']
const DAY_MS = 86_400_000
// whole month names and their abbreviations (accents are already stripped by flat): "Market 2025" or "Junior 2025" must not read as "Mar 2025" / "Jun 2025"
const MONTH_ALT = ['january', 'jan', 'february', 'feb', 'march', 'mar', 'april', 'apr', 'may', 'june', 'jun', 'july', 'jul', 'august', 'aug', 'september', 'sept', 'sep', 'october', 'oct', 'november', 'nov', 'december', 'dec',
  'januar', 'februar', 'marz', 'mai', 'juni', 'juli', 'oktober', 'okt', 'dezember', 'dez',
  'janvier', 'janv', 'fevrier', 'fevr', 'mars', 'avril', 'avr', 'juin', 'juillet', 'juil', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'].join('|')
const YEAR = '((?:19|20)\\d{2})'
// Month-name forms run on the flattened quote (flat() turns punctuation into spaces); numeric dates keep their / . - separators, so they run on the
// raw quote, lower-cased with non-breaking spaces made plain.
const YEAR_AFTER_MONTH = [
  new RegExp(`\\b(?:${MONTH_ALT})\\b\\.?\\s+(?:\\d{1,2}(?:st|nd|rd|th)?\\s+(?:(?:and|to)\\s+)?)*${YEAR}\\b`, 'g'),                    // October 2, 2025 / October 2-4, 2025 / October 2 and 3, 2025 / Oct 2025
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\.?\\s+(?:of\\s+)?(?:${MONTH_ALT})\\b\\.?,?\\s+${YEAR}\\b`, 'g'),                                // 2 October 2025 / 2nd of October, 2025
]
// A year BEFORE the month, on the raw quote (punctuation kept, so a year that ends a sentence or a clause is not read as the year of the next date):
// day-first may follow a comma ("2025, 2 October"); month-first must follow the year directly with a day after the month ("2025 October 2"), so
// "Prices in 2025 may rise" is not a date and "Revenue grew in 2025. On October 2" is not 2025. A newline never joins them.
const APOSTROPHE_YEAR = [   // "Oct 2nd '25", "2 October '25" (raw quote)
  new RegExp(`(?:${MONTH_ALT})\\b\\.? \\d{1,2}(?:st|nd|rd|th)?,? ['\u2019](\\d{2})\\b`, 'g'),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)? (?:of )?(?:${MONTH_ALT})\\b\\.?,? ['\u2019](\\d{2})\\b`, 'g'),
]
const YEAR_BEFORE_MONTH = [
  new RegExp(`(?<![\\d./-])${YEAR},? (?:(?:on|of|the) )?\\d{1,2}(?:st|nd|rd|th)?\\.? (?:of )?(?:${MONTH_ALT})\\b`, 'g'),                      // 2025, 2 October / in 2025 on 2 October / 2025 the 2nd of October
  new RegExp(`(?<![\\d./-])${YEAR} (?:(?:on|of|the) )?(?:${MONTH_ALT})\\b\\.? \\d{1,2}(?:st|nd|rd|th)?\\b`, 'g'),                              // 2025 October 2
]
const YEAR_IN_NUMERIC_DATE = [
  new RegExp(`(?<![\\d./-])\\d{1,2}[./-]\\d{1,2}[./-]${YEAR}(?![\\d])`, 'g'),                                                                   // 02/10/2025, 2.10.2025, 2-10-2025
  new RegExp(`(?<![\\d./-])${YEAR}[./-]\\d{1,2}[./-]\\d{1,2}(?![\\d])`, 'g'),                                                                   // 2025-10-02
]
const statedYears = (q: string, raw: string): number[] => [
  ...YEAR_AFTER_MONTH.flatMap(re => [...q.matchAll(re)].map(m => Number(m[1]))),
  ...YEAR_IN_NUMERIC_DATE.flatMap(re => [...raw.matchAll(re)].map(m => Number(m[1]))),
  ...YEAR_BEFORE_MONTH.flatMap(re => [...raw.matchAll(re)].map(m => Number(m[1]))),
  ...APOSTROPHE_YEAR.flatMap(re => [...raw.matchAll(re)].map(m => 2000 + Number(m[1]))),
]
const parseDay = (s: string | null | undefined): number | null => {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const t = Date.parse(`${s}T00:00:00Z`)
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s ? null : t
}

// Does this date quote name this day? Month by name or number, plus its day or its year; ISO dates exactly. A relative day ("today",
// "yesterday", "N days ago", "N weeks ago") counts only when it lands on the claimed day (+-1 day) from when the page was read. "Months
// ago", "last year" and a bare year never date an event.
export function dateQuoteNames(isoDay: string, dateQuote: string, readAt: number): boolean {
  const t = parseDay(isoDay); if (t === null) return false
  const d = new Date(t), y = d.getUTCFullYear(), m = d.getUTCMonth(), dd = d.getUTCDate()
  const q = flat(dateQuote)
  if (q.includes(isoDay)) return true
  const rel = /\b(today|yesterday|(\d{1,2}) (day|days|week|weeks) ago)\b/.exec(q)
  if (rel) {
    const back = rel[1] === 'today' ? 0 : rel[1] === 'yesterday' ? 1 : Number(rel[2]) * (rel[3].startsWith('week') ? 7 : 1)
    return Math.abs((readAt - back * DAY_MS) - t) <= 1.5 * DAY_MS
  }
  const monthNamed = [MONTHS, MONTHS_DE, MONTHS_FR].some(list => new RegExp(`\\b${list[m]}`).test(q))
  const monthNumber = new RegExp(`(^|\\D)0?${m + 1}[./ -]`).test(q) || new RegExp(`[./ -]0?${m + 1}(\\D|$)`).test(q)
  const hasYear = new RegExp(`\\b${y}\\b`).test(q)
  // a quote that STATES a year in date position must state only THIS one: "2 October 2025" never dates 2026-10-02 (a year-old event read as current),
  // and neither does "2 October 2025 (updated 2 October 2026)": the date quote is the date text, so any other year in it fails closed. Only a year in
  // date position counts (after a month name and its day, or inside a numeric date; an apostrophe year "'25"): "1944 W 4th Ave. on Sept. 20" has a
  // street number, not a year. No stated year ("2 October") is judged on the month and day alone, as before. A bare two-digit year ("2 Oct 25") is
  // not read: it cannot be told from a count ("2 October, 25 people").
  const years = statedYears(q, dateQuote.toLowerCase().replace(/[\u00a0\u2009\u202f]/g, ' '))
  if (years.some(v => v !== y)) return false
  const hasDay = new RegExp(`(^|\\D)0?${dd}(st|nd|rd|th)?(\\D|$)`).test(q)
  // a quote that states a day of the month must state THIS day ("October 2, 2026" never dates 2026-10-03); month and year alone are accepted
  // only when the quote states no day at all
  const statesADay = (q.replace(new RegExp(`\\b${y}\\b`, 'g'), ' ').match(/(^|\D)(0?[1-9]|[12]\d|3[01])(st|nd|rd|th)?(\D|$)/) ?? null) !== null
  return (monthNamed && (hasDay || (hasYear && !statesADay))) || (monthNumber && hasDay && hasYear)
}

export function inWindow(isoDay: string | null, now: number, windowDays = WINDOW_DAYS): boolean {
  const t = parseDay(isoDay)
  const today = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`)   // by calendar day: today and the 90 days before it
  return t !== null && t <= today && t >= today - windowDays * DAY_MS
}

export interface EventToVerify { company: string; whatHappened: string; whyNow: string; quote: string; eventDate: string | null; dateQuote: string | null; sourceUrl: string }
export interface PersonToVerify { name: string; title: string | null; quote: string; sourceUrl: string; sourceText: string }
export interface OpenedPage { url: string; text: string; readAt: number; metaDates?: string[] }   // the page as opened now (readAt: ms); metaDates: its own <meta> / JSON-LD date lines ("article:published_time: 2026-11-05T16:06:27+00:00")

export interface Verdict {
  event: { literal: boolean; support: number | null; ok: boolean; passage: string }
  day: { date: string | null; onPage: boolean; inWindow: boolean }
  person: { name: string | null; title: string | null; literal: boolean; support: number | null; ok: boolean; sourceUrl: string | null }
  ready: boolean
  why: string | null       // the first thing that is not proven, in words; null when ready
}

export async function verifyLead(ev: EventToVerify, page: OpenedPage, person: PersonToVerify | null, decide: Decide, opts: { now?: number; windowDays?: number } = {}): Promise<Verdict> {
  const now = opts.now ?? Date.now()
  const literal = quoteOnPage(ev.quote, page.text)
  const passage = literal ? passageAround(ev.quote, page.text) : ''
  let support: number | null = null
  if (literal) {
    const a = await decide({ page_excerpt: passage.slice(0, 6000), page_url: page.url }, { claim: { type: 'noul', instructions: `Does the excerpt support this fact: ${ev.company} ${ev.whatHappened || ev.whyNow}` } }).catch(() => null)
    support = typeof a?.claim === 'number' ? a.claim : null
  }
  const eventOk = literal && support !== null && support >= SUPPORT_MIN
  const dateSource = `${page.text}\n${(page.metaDates ?? []).join('\n')}`   // the page's own declared dates count as the page (the reader was shown them)
  const dateOnPage = !!(ev.eventDate && ev.dateQuote && quoteOnPage(ev.dateQuote, dateSource, 1) && dateQuoteNames(ev.eventDate, ev.dateQuote, page.readAt))
  const dayIn = dateOnPage && inWindow(ev.eventDate, now, opts.windowDays)
  const p = { name: person?.name ?? null, title: person?.title ?? null, literal: false, support: null as number | null, ok: false, sourceUrl: person?.sourceUrl ?? null }
  if (person) {
    const surname = flat(person.name).split(' ').filter(w => w.length >= 2).pop() ?? ''
    const around = passageAround(person.quote, person.sourceText, 300)
    p.literal = !!surname && quoteOnPage(person.quote, person.sourceText) && flat(`${around} ${person.quote}`).split(' ').includes(surname)
    if (p.literal) {
      const a = await decide({ excerpt: around.slice(0, 6000), source_url: person.sourceUrl }, { role: { type: 'noul', instructions: `Does the excerpt show that ${person.name} works at ${ev.company} as ${person.title ?? 'a senior person'} or in another senior, decision-making role there?` } }).catch(() => null)
      p.support = typeof a?.role === 'number' ? a.role : null
      p.ok = p.support !== null && p.support >= SUPPORT_MIN
    }
  }
  const why = !literal ? 'the quote is not on the cited page'
    : !eventOk ? (support === null ? 'the second check could not run' : 'the cited passage does not support the event')
    : !dateOnPage ? 'the event day is not stated on the cited page'
    : !dayIn ? 'the event day is outside the time window'
    : !person ? 'no named person'
    : !p.literal ? 'the person is not named on their cited page'
    : !p.ok ? (p.support === null ? 'the second check could not run' : 'the cited page does not show the person in a senior role there')
    : null
  return { event: { literal, support, ok: eventOk, passage }, day: { date: dateOnPage ? ev.eventDate : null, onPage: dateOnPage, inWindow: dayIn }, person: p, ready: why === null, why }
}
