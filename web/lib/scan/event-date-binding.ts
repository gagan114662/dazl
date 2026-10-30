// Is a claimed event day supported by the FETCHED page for THIS company and THIS event (#460)? A day that merely appears somewhere on the page does not date the
// event: a publication / update stamp ("Published ...", "Posted ...", "Updated ...") dates the page, another company's announcement or an unrelated conference on
// the same day dates something else, and a page with no date at all supports none. The day counts only when it is stated, outside a stamp, in the very sentence that
// carries the evidence quote, or in a sentence that names the same company and describes the same event (shares at least two content words with the quote).
// Anything else is undated: the default is "unknown", never a kept guess. Pure; no model, no network.
import { datePositions } from './date-in-text.ts'
import { CUE, NOT_EVENT } from './page-timing.ts'

const STOP = new Set('this that with from have been were they their will would could should about into over after before more most other these those when where which while also very just than then them what your ours its our new'.split(' '))
const SUFFIX = new Set(['inc', 'llc', 'ltd', 'corp', 'corporation', 'company', 'co', 'gmbh', 'sarl', 'sas', 'plc', 'lp', 'llp', 'the', 'group'])
const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(Boolean)
const companyTokens = (company: string) => words(company).filter(w => !SUFFIX.has(w) && w.length > 1)
const normalise = (s: string) => s.replace(/\s+/g, ' ').trim()

interface Span { start: number; end: number }
// Sentence spans. A period inside a date match ("Oct. 15") or an abbreviation is not a boundary.
function sentences(text: string, protectedSpans: Span[]): Span[] {
  const out: Span[] = []; let start = 0
  for (const m of text.matchAll(/[.!?]+["')\]]?\s+(?=[A-Z0-9"“(])/g)) {
    const at = m.index! + m[0].length
    if (protectedSpans.some(p => m.index! >= p.start && m.index! < p.end)) continue
    if (/\b(?:Mr|Mrs|Ms|Dr|St|Inc|Ltd|Co|Corp|vs|No|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.\s*$/.test(text.slice(Math.max(0, m.index! - 6), m.index! + 1))) continue
    out.push({ start, end: at }); start = at
  }
  out.push({ start, end: text.length }); return out
}

export function eventDateBound(eventDate: string | null, pageText: string, quote: string, company: string): { bound: boolean; why: string } {
  if (!eventDate || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return { bound: false, why: 'no event date' }
  const text = normalise(pageText), q = normalise(quote)
  const evYear = +eventDate.slice(0, 4), older = [...q.matchAll(/\b(19[89]\d|20\d{2})\b/g)].map(m => +m[1]).filter(y => y <= evYear - 2)
  if (older.length) return { bound: false, why: `the quote itself names ${Math.min(...older)}, an earlier year than the claimed day` }
  const hits = datePositions(text).filter(d => d.day === eventDate)
  if (!hits.length) return { bound: false, why: 'the fetched page never states that day' }
  const qAt = q ? text.toLowerCase().indexOf(q.slice(0, 80).toLowerCase()) : -1
  const sents = sentences(text, datePositions(text).map(d => ({ start: d.index, end: d.end })))
  const sentOf = (i: number) => sents.find(s => i >= s.start && i < s.end)!
  const qSent = qAt >= 0 ? sentOf(qAt) : null
  const co = companyTokens(company), qWords = new Set(words(q).filter(w => w.length >= 4 && !STOP.has(w) && !co.includes(w)))
  let stamped = false, unbound = false
  for (const h of hits) {
    const before = text.slice(Math.max(0, h.index - 40), h.index).slice(-30)
    if (CUE.test(before) || NOT_EVENT.test(before)) { stamped = true; continue }        // the page's own date, not the event's
    const s = sentOf(h.index)
    if (qSent && s.start === qSent.start) return { bound: true, why: 'stated in the sentence that carries the evidence quote' }
    const sw = words(text.slice(s.start, s.end)), swSet = new Set(sw)
    const namesCompany = co.length > 0 && co.every(t => swSet.has(t))
    const shared = [...qWords].filter(w => swSet.has(w)).length
    if (namesCompany && shared >= 2) return { bound: true, why: 'stated in a sentence naming the same company and describing the same event' }
    unbound = true
  }
  return { bound: false, why: unbound ? 'the day is stated on the page, but not for this company and event' : stamped ? 'the day appears only as a publication / update stamp' : 'no bound statement of the day' }
}
