// Is a claimed event day supported by the FETCHED page for THIS company and THIS event (#460)? A day that merely appears somewhere on the page does not date the
// event: a publication / update stamp ("Published ...", "Posted ...", "Updated ...") dates the page, another company's announcement or an unrelated conference on
// the same day dates something else, and a page with no date at all supports none. The day counts only when it is stated, outside a stamp, in the very sentence that
// carries the evidence quote, or in a sentence that names the same company and describes the same event (shares at least two content words with the quote).
// Within a sentence it is the CLAUSE that counts: "Aurora opened an office, while UnrelatedCo launched a tool on 2026-10-15" dates UnrelatedCo's launch, not
// Aurora's opening, so a day binds only in a clause that itself names this company (#460 review).
// Anything else is undated: the default is "unknown", never a kept guess. Pure; no model, no network.
import { datePositions, eventYears } from './date-in-text.ts'
import { NOT_EVENT } from './page-timing.ts'

// A publication / update stamp just before a day: "Posted ...", "Published ...", "Updated ..." date the page. "announced on <day>" is
// the company's own statement of when, so it is not a stamp here (page-timing's CUE, which reads publication lines, does include it).
const STAMP = /(?:posted|published|reposted|republished)\b[^.\n]{0,25}$/i

const STOP = new Set('this that with from have been were they their will would could should about into over after before more most other these those when where which while also very just than then them what your ours its our new'.split(' '))
const SUFFIX = new Set(['inc', 'llc', 'ltd', 'corp', 'corporation', 'company', 'co', 'gmbh', 'sarl', 'sas', 'plc', 'lp', 'llp', 'the', 'group'])
const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(Boolean)
const companyTokens = (company: string) => words(company).filter(w => !SUFFIX.has(w) && w.length > 1)
const normalise = (s: string) => s.replace(/\s+/g, ' ').trim()

interface Span { start: number; end: number }
// Sentence spans. A period inside a date match ("Oct. 15") or an abbreviation is not a boundary.
// Scripts that end sentences without a following space or capital (。！？ Japanese/Chinese, । Hindi, ؟ Arabic) end them on the mark itself.
function sentences(text: string, protectedSpans: Span[]): Span[] {
  const out: Span[] = []; let start = 0
  for (const m of text.matchAll(/[.!?]+["')\]]?\s+(?=[A-Z0-9"“(])|[。！？।؟]+\s*/g)) {
    const at = m.index! + m[0].length
    if (protectedSpans.some(p => m.index! >= p.start && m.index! < p.end)) continue
    if (/\b(?:Mr|Mrs|Ms|Dr|St|Inc|Ltd|Co|Corp|vs|No|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.\s*$/.test(text.slice(Math.max(0, m.index! - 6), m.index! + 1))) continue
    out.push({ start, end: at }); start = at
  }
  out.push({ start, end: text.length }); return out
}

// Clause spans inside one sentence: a connective that starts another statement ("; ", " while ", " whereas ", " but ",
// " after ", " before ", " following ", " until ", ", and ", " and " + a capitalised subject, " - ",
// " meanwhile ", " although ", and the native clause commas 、，، ) begins a new clause. A date's own text and the company's
// own name ("Smith and Sons", "Better But Cheaper") are never split. A day inside parentheses has the parenthetical as its
// clause ("(UnrelatedCo launched a tool on <day>)"); parentheses split nothing else, so "Aurora (Toronto) opened ... on <day>" stays whole. (", as" is not a break: "..., as the firm said on <day>"
// is still the company's own statement.)
const CLAUSE_BREAK = /;\s*|\s+(?:while|whereas|but|meanwhile|although|though|after|before|following|until)\s+|,\s+(?:and|while|whereas|but|meanwhile)\s+|\s+and\s+(?=[A-Z])|\s+[-–—]\s+|[、，،]\s*/g
function clauses(text: string, s: Span, protectedSpans: Span[]): Span[] {
  const out: Span[] = []; let start = s.start
  const part = text.slice(s.start, s.end)
  for (const m of part.matchAll(CLAUSE_BREAK)) {
    const at = s.start + m.index!
    if (protectedSpans.some(p => at >= p.start && at < p.end)) continue
    out.push({ start, end: at }); start = at + m[0].length
  }
  out.push({ start, end: s.end }); return out
}

export function eventDateBound(eventDate: string | null, pageText: string, quote: string, company: string): { bound: boolean; why: string } {
  if (!eventDate || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return { bound: false, why: 'no event date' }
  const text = normalise(pageText), q = normalise(quote)
  const evYear = +eventDate.slice(0, 4), older = eventYears(q).filter(y => y <= evYear - 2)   // background years ("founded in 2020") do not date the event
  if (older.length) return { bound: false, why: `the quote itself names ${Math.min(...older)}, an earlier year than the claimed day` }
  const hits = datePositions(text).filter(d => d.day === eventDate)
  if (!hits.length) return { bound: false, why: 'the fetched page never states that day' }
  const qCore = q.replace(/^(?:\.{3,}|…)+\s*/, '').replace(/\s*(?:\.{3,}|…)+$/, '')   // a cut quote's ellipsis, as verifyEvidence strips it
  const qAt = qCore ? text.toLowerCase().indexOf(qCore.slice(0, 80).toLowerCase()) : -1
  const dateSpans = datePositions(text).map(d => ({ start: d.index, end: d.end }))
  const name = normalise(company)
  const nameSpans = name.length >= 2 ? [...text.toLowerCase().matchAll(new RegExp(name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].map(m => ({ start: m.index!, end: m.index! + name.length })) : []
  const sents = sentences(text, dateSpans)
  const sentOf = (i: number) => sents.find(s => i >= s.start && i < s.end)!
  const qSent = qAt >= 0 ? sentOf(qAt) : null
  const co = companyTokens(company), qWords = new Set(words(q).filter(w => w.length >= 4 && !STOP.has(w) && !co.includes(w)))
  // the quote's own predicate: the first content word after the company's name ("opened" in "Aurora Agency opened a new office")
  const afterName = co.length ? words(q.slice(Math.max(0, q.toLowerCase().indexOf(co[co.length - 1]) + co[co.length - 1].length))).find(w => w.length >= 3 && !STOP.has(w)) ?? null : null
  let stamped = false, unbound = false
  for (const h of hits) {
    const before = text.slice(Math.max(0, h.index - 40), h.index).slice(-30)
    if (STAMP.test(before) || NOT_EVENT.test(before)) { stamped = true; continue }      // the page's own date, not the event's
    const s = sentOf(h.index)
    const paren = [...text.slice(s.start, s.end).matchAll(/\(([^()]*)\)/g)].map(m => ({ start: s.start + m.index!, end: s.start + m.index! + m[0].length })).find(p => h.index > p.start && h.index < p.end)
    const cl = paren ?? clauses(text, s, [...dateSpans, ...nameSpans]).find(c => h.index >= c.start && h.index < c.end) ?? s
    const clauseText = text.slice(cl.start, cl.end), cw = new Set(words(clauseText))
    // Latin-script names by their words; any script (Devanagari, Arabic, Japanese ... where words() finds no a-z tokens) by the name itself in the clause
    const namesCompany = co.length > 0 ? co.every(t => cw.has(t)) : normalise(company).length >= 2 && clauseText.toLowerCase().includes(normalise(company).toLowerCase())
    if (!namesCompany) { unbound = true; continue }                                      // the day's own clause is about something else
    if (qSent && s.start === qSent.start) return { bound: true, why: 'stated in the clause of the evidence sentence that names this company' }
    // another sentence must describe the same event: share the quote's predicate (not "closed" for "opened") and two content words
    const shared = [...qWords].filter(w => cw.has(w)).length
    if (shared >= 2 && (afterName === null || cw.has(afterName))) return { bound: true, why: 'stated in a clause naming the same company and describing the same event' }
    unbound = true
  }
  return { bound: false, why: unbound ? 'the day is stated on the page, but not for this company and event' : stamped ? 'the day appears only as a publication / update stamp' : 'no bound statement of the day' }
}
