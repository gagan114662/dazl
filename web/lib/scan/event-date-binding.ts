// Is a claimed event day supported by the FETCHED page for THIS company and THIS event (#460)? A day that merely appears somewhere on the page does not date the
// event: a publication / update stamp ("Published ...", "Posted ...", "Updated ...") dates the page, another company's announcement or an unrelated conference on
// the same day dates something else, and a page with no date at all supports none. The day counts only when it is stated, outside a stamp, in the very sentence that
// carries the evidence quote, or in a sentence that names the same company and describes the same event (shares at least two content words with the quote).
// Within a sentence, nothing may stand between this company's mention and the day that starts another party's statement: "Aurora opened an office, while
// UnrelatedCo launched a tool on 2026-10-15" (or "..., as the city held a festival on ...") dates someone else's event, not Aurora's opening (#460 review).
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

// (Other scripts only.) Clause spans inside one sentence: a connective that starts another statement ("; ", " while ", " whereas ", " but ",
// " after ", " before ", " following ", " until ", ", and ", " and " + a capitalised subject AND a verb ("and UnrelatedCo
// launched", not "Toronto and Vancouver on"), ", which / who / whose" (unless it follows this company's own name), " - ",
// " meanwhile ", " although ", and the native clause commas 、，، ) begins a new clause. A date's own text and the company's
// own name ("Smith and Sons", "Better But Cheaper") are never split. A day inside parentheses has the parenthetical as its
// clause ("(UnrelatedCo launched a tool on <day>)"); parentheses split nothing else, so "Aurora (Toronto) opened ... on <day>" stays whole. (", as" is not a break: "..., as the firm said on <day>"
// is still the company's own statement.)
const CLAUSE_BREAK = /;\s*|\s+(?:while|whereas|but|meanwhile|although|though|after|before|following|until)\s+|,\s+(?:and|while|whereas|but|meanwhile)\s+|\s+and\s+(?=(?:[A-Z][\w&.'’-]*\s+){1,4}[a-z]+(?:ed|es|s)\b)|,\s+(?:which|who|whose)\s+|\s+[-–—]\s+|[、，،]\s*/g
// Known fail-closed losses: an aside ("Aurora - the Toronto firm - opened ...") or "after months of ..." cuts the company off its
// own day; such an event reads undated (held), never wrongly dated.
function clauses(text: string, s: Span, protectedSpans: Span[], name = ''): Span[] {
  const out: Span[] = []; let start = s.start
  const part = text.slice(s.start, s.end)
  for (const m of part.matchAll(CLAUSE_BREAK)) {
    const at = s.start + m.index!
    if (protectedSpans.some(p => at >= p.start && at < p.end)) continue
    if (/^,\s+(?:which|who|whose)\s/i.test(m[0]) && name && text.slice(Math.max(s.start, at - name.length), at).toLowerCase() === name.toLowerCase()) continue // "Aurora Agency, which opened ..." is still Aurora's clause
    out.push({ start, end: at }); start = at + m[0].length
  }
  out.push({ start, end: s.end }); return out
}

// Latin script: another subject between this company's mention and the day. A capitalised word that is not part of the
// company's name, not a month / weekday / sentence word, and not a place (a capitalised run after "in / at / on / along /
// across / near / from / to / throughout / around", or chained to one by "and" or a comma: "in Toronto and Vancouver", "in
// Toronto, ON" - but not when a verb follows it: "in Austin, UnrelatedCo launched") names someone else, so
// the day belongs to that someone: "Aurora opened an office, while UnrelatedCo launched a tool on <day>" (#460 review). A ';'
// between them ends the statement too. Datelines ("TORONTO, Oct. 15, 2026 - Aurora ..."), "(on <day>)" and "after months of
// planning" put no other subject in between and still bind. Known fail-closed losses: a joint announcement ("Aurora and Beta
// Labs opened ...") and an aside naming a non-place ("Aurora - the firm Gartner ranked - opened ...") read undated.
const PREP = new Set(['in', 'at', 'on', 'along', 'onto', 'across', 'near', 'from', 'to', 'throughout', 'around', 'into', 'outside', 'inside'])
const PLAIN_CAPS = new Set('the a an it its this that these those today yesterday on in at by for with and but while after before as so also then mr ms mrs dr st prnewswire businesswire globenewswire'.split(' '))
const COUNTERPART = new Set('after before following alongside beside besides with as when while than unlike like versus vs against'.split(' '))
const LEGAL = new Set('inc ltd llc corp co plc gmbh'.split(' '))
const CAL = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\.?$/i
const fold = (t: string) => Array.from(t, ch => { const f = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); return f.length === ch.length ? f : ch }).join('')
// A connective between the mention and the day starts another statement, whatever case its subject is in: "; ", " while ",
// " whereas ", " but ", " meanwhile ", " although ", " though ", ", which / who / whose" (not right after the company's own
// name), and " and / as / when / once / since / after / before / following / until " when another subject and a verb in
// any tense follow before the next comma ("before the city held", "and the city will launch", "as UnrelatedCo launched",
// "with UnrelatedCo launching"). The subject is 1-4 words that are not a preposition or a verb form, and not the company
// itself ("it", "the firm"), so "after months of planning, opened", "runs until <day>", "in Toronto and Vancouver on <day>",
// "and hired ten designers", "and on <day> the ribbon was cut" and "as the firm said on <day>" still bind (#460 review).
// Matched on the text from the gap onwards (the lookahead may read past the day); only a match that starts inside the gap counts.
const PAST = String.raw`(?:held|spoke|sold|won|made|began|broke|took|ran|met|built|cut|set|hit|led|left|became|got|gave|bought|brought|chose|drew|fell|found|grew|kept|lost|paid|put|rose|said|sent|spent|struck|told|went|wrote)`
const VERB = String.raw`\b(?:${PAST}|(?!(?:its|this|his|hers|theirs|ours|yes|less|plus|thus|was|is|has|does)\b)[a-z]{2,}(?:ed|es|s)|(?:will|shall|would|is|are|was|were|has|have|had)\s+[a-z]+)\b`
const SUBJ = String.raw`(?!(?:it|they|we|he|she|the\s+(?:firm|company|agency|business|group|team))\b)(?:(?:the|a|an|its|their|his|her|this|that)\s+)?(?:(?!(?:of|in|on|at|for|to|from|with|by|into|over|and|or)\b)(?![a-z]+(?:ed|ing|ly)\b)[A-Za-z0-9&'’.-]+\s+){1,4}?`
const VERB_WORD = new RegExp(String.raw`^(?:${PAST}|spoke|(?!(?:its|this|his|hers|theirs|ours|yes|less|plus|thus|as|us|is|was|has|does)$)[a-z]{2,}(?:ed|es|s|ing))$`)
const LATIN_BREAK = new RegExp(String.raw`;|\s+(?:while|whereas|but|meanwhile|although|though)\s+|,\s+(?:which|who|whose)\s+|,?\s+(?:and|as|so|when|once|since|after|before|following|until)\s+(?=${SUBJ}${VERB})|,?\s+with\s+(?=${SUBJ}[a-z]+ing\b)`, 'gi')
function connectiveIn(tail: string, gap: number): boolean {
  const own = /^\s*,\s+(?:which|who|whose)\s/i.test(tail)   // "Aurora Agency, which opened ..." is still Aurora's
  for (const m of tail.matchAll(LATIN_BREAK)) {
    if (m.index! >= gap) break
    if (!(own && m.index! === 0)) return true
  }
  return false
}
function otherSubjectBetween(segment: string, co: string[], known: Set<string> = new Set()): boolean {
  if (segment.includes(';')) return true
  segment = segment.replace(/^\s*\([^()]*\)/, ' ')   // an aside right after the name ("Aurora Agency (Toronto) opened ...") is about the company
  const toks = [...segment.matchAll(/[A-Za-z0-9][A-Za-z0-9&'’.-]*|,/g)].map(m => m[0])
  let place = false, attached = true   // attached: still in the capitalised run straight after the company's name
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i], prev = (toks[i - 1] ?? '').toLowerCase(), next = toks[i + 1] ?? ''
    if (w === ',') { attached = false; continue }
    const lw = w.toLowerCase().replace(/[.'’]+$/, '')
    if (/^[A-Z]/.test(w) && w.length > 1) {
      const capPrev = /^[A-Z]/.test(toks[i - 1] ?? '')
      // a place: right after a preposition, or chained to a place by "and", a comma or another capitalised word - unless the
      // word is followed by a verb, which makes it a subject ("in Austin, UnrelatedCo launched ...")
      if (LEGAL.has(lw) && (i === 0 || co.includes(prev.replace(/[.'’]+$/, '')))) continue   // "Aurora Agency Inc. opened ..."
      // followed by a verb or a legal suffix, the word is a subject ("in Austin, UnrelatedCo launched", "in Ottawa, Zenith Corp opened")
      const verbNext = (VERB_WORD.test(next) && !PREP.has(next)) || LEGAL.has(next.toLowerCase().replace(/[.'’]+$/, ''))
      // a capital joined by a comma is a place only when a place's neighbour follows ("Toronto, ON on", "Austin, Texas and"):
      // "in Toronto, Zenith held a gala" and "in Toronto, UnrelatedCo's tool launched" name someone else
      const placeNext = !next || next === ',' || next === 'and' || PREP.has(next) || /^[A-Z0-9]/.test(next)
      if (PREP.has(prev)) place = !verbNext
      else if (place && prev === ',') place = !verbNext && placeNext
      else if (place && (prev === 'and' || capPrev)) place = !verbNext
      else place = false
      // the quote's own capitals are the company's - unless one is followed by a verb away from the name ("as UnrelatedCo launched")
      // or one introduced as a counterpart ("after UnrelatedCo's launch", "alongside UnrelatedCo, launching ...")
      const quoted = known.has(lw) && (!verbNext || attached) && !COUNTERPART.has(prev)
      if (!(place || co.includes(lw) || quoted || PLAIN_CAPS.has(lw) || CAL.test(w))) return true
      continue
    }
    attached = false
    if (lw !== 'and') place = false
  }
  return false
}

// A mention inside someone else's modifier is not the event's subject. Looking only
// from a name toward a day loses the governing subject before that name, e.g.
// "UnrelatedCo, which partners with Aurora Agency, opened ... on <day>".
// Conservative: prepositional and parenthetical mentions stay undated even when
// natural-language resolution would need a model to decide their role.
function subordinateMention(prefix: string): boolean {
  if (prefix.lastIndexOf('(') > prefix.lastIndexOf(')')) return true
  if (/,\s*(?:which|who|whose)\b/i.test(prefix)) return true
  if (/\b(?:hired|engaged|retained|selected|appointed|acquired|bought|partner)\s*$/i.test(prefix)) return true
  return /\b(?:with|of|for|by|from|to|alongside|beside|near|including|than|unlike|versus|vs)\s*$/i.test(prefix)
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
  const lastTok = co.length ? new RegExp(`\\b${co[co.length - 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').exec(q) : null
  const AUX = new Set(['today', 'recently', 'officially', 'also', 'just', 'now', 'has', 'have', 'had', 'is', 'was', 'will', 'would', 'which', 'who', 'that', 'inc', 'ltd', 'llc'])
  const afterName = lastTok ? words(q.slice(lastTok.index + lastTok[0].length)).find(w => w.length >= 3 && !STOP.has(w) && !AUX.has(w)) ?? null : null
  const qCaps = new Set([...q.matchAll(/\b[A-Z][A-Za-z0-9&'’.-]*/g)].map(m => m[0].toLowerCase().replace(/[.'’]+$/, '')))
  let stamped = false, unbound = false
  for (const h of hits) {
    const before = text.slice(Math.max(0, h.index - 40), h.index).slice(-30)
    // the page's own date, not the event's - including a dateline that opens the sentence ("Announced on <day>: ...")
    if (STAMP.test(before) || NOT_EVENT.test(before) || /(?:^|[.!?:]\s*)announced(?:\s+on)?\s*$/i.test(text.slice(Math.max(0, h.index - 30), h.index))) { stamped = true; continue }
    const s = sentOf(h.index)
    let cw: Set<string>
    if (co.length > 0) {
      // Latin script: the sentence names the company by its words, and no other subject stands between its nearest mention and the day
      const mention = new RegExp(`\\b${co.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^a-z0-9]+')}\\b`, 'gi')
      const sent = fold(text.slice(s.start, s.end))   // accents folded per character, so positions stay the same ("Müller" is "muller")
      const ms = [...sent.matchAll(mention)].map(m => ({ start: s.start + m.index!, end: s.start + m.index! + m[0].length }))
      if (!ms.length) { unbound = true; continue }
      const dist = (m: Span) => Math.min(Math.abs(m.start - h.index), Math.abs(m.end - h.index))
      const near = ms.reduce((a, m) => dist(m) < dist(a) ? m : a)
      if (subordinateMention(text.slice(s.start, near.start)) || /^[’']s\b/.test(text.slice(near.end))) { unbound = true; continue }
      const between = h.index >= near.end ? text.slice(near.end, h.index) : text.slice(h.end, near.start)
      // in another sentence, the quote's own capitalised words (its places and the office it names) are not someone else
      const tail = h.index >= near.end ? text.slice(near.end, s.end) : text.slice(h.end, s.end)
      if (/\b(?:said|says|announced|reported|confirmed|revealed|noted)\s+(?:that\s+)?(?:(?:its|their|the|a|an)\s+)?(?:client|customer|partner|company|firm|business)\b/i.test(between)) { unbound = true; continue }
      if (connectiveIn(tail, between.length)) { unbound = true; continue }                // another statement starts between them
      // the quote's own capitalised words (its places, the office it names) are the company's statement, not someone else
      if (otherSubjectBetween(between, co, qCaps)) { unbound = true; continue }           // the day belongs to someone else named in between
      cw = new Set(words(sent))
    } else {
      // other scripts (no a-z words to find subjects by): the clause, split at native and English connectives, must contain the name itself
      const cl = clauses(text, s, [...dateSpans, ...nameSpans], name).find(c => h.index >= c.start && h.index < c.end) ?? s
      const clauseText = text.slice(cl.start, cl.end)
      if (!(name.length >= 2 && clauseText.toLowerCase().includes(name.toLowerCase()))) { unbound = true; continue }
      cw = new Set(words(clauseText))
    }
    if (qSent && s.start === qSent.start) return { bound: true, why: 'stated in the clause of the evidence sentence that names this company' }
    // another sentence must describe the same event: share the quote's predicate (not "closed" for "opened") and two content words
    const shared = [...qWords].filter(w => cw.has(w)).length
    if (shared >= 2 && (afterName === null || cw.has(afterName))) return { bound: true, why: 'stated in a clause naming the same company and describing the same event' }
    unbound = true
  }
  return { bound: false, why: unbound ? 'the day is stated on the page, but not for this company and event' : stamped ? 'the day appears only as a publication / update stamp' : 'no bound statement of the day' }
}
