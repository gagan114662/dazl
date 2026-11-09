// Claim-to-quote binding for seller research (#379). A verbatim quote proves only that the words are on the page;
// it does not prove the CLAIM. "10,000 employees" cited with "Acme builds tools for modern teams" is a real quote and
// an invented headcount. A statement is source-backed only when its quote also carries the claim itself:
// - every number in the claim appears in the quote ("10 to 50 staff" backs "10-50 employees", never "10,000");
// - a location: every place word of the claim appears in the quote ("Texas" needs "Texas");
// - anything else: at least one distinctive word of the claim appears in the quote (plural/singular tolerant), and
//   generic filler ("companies", "teams") alone never counts when the claim has a more specific word.
// Pure and deterministic; no page needed, so the same check runs at research time and on any persisted block.
// The same normalization as evidence.ts `norm`, kept here on purpose: icp.ts imports this from the browser bundle (the leads page), and
// evidence.ts reads process.env when it loads, which a client bundle without a process shim cannot do.
const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{M}\p{N}@.+ ]+/gu, ' ').replace(/\s+/g, ' ').trim()

const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'at', 'by', 'from', 'who', 'that', 'their', 'our', 'your', 'its', 'is', 'are', 'be', 'as', 'than', 'per', 'up', 'over', 'under', 'more', 'less', 'all', 'any', 'based', 'across'])
const GENERIC = new Set(['company', 'companies', 'business', 'businesses', 'team', 'teams', 'people', 'customer', 'customers', 'organization', 'organizations', 'organisation', 'organisations', 'firm', 'firms', 'group', 'groups', 'user', 'users', 'employee', 'employees', 'staff', 'size', 'sized'])

const words = (s: string) => norm(s).replace(/[.@+]/g, ' ').split(' ').filter(w => w && !STOP.has(w))
const numbers = (s: string) => (s.replace(/(\d),(?=\d{3}\b)/g, '$1').match(/\d+(?:\.\d+)?/g) ?? [])
// Light stemming so "dental practices" matches "a dental practice" and "clinic owners" matches "clinic owner".
const stem = (w: string) => w.replace(/(?:ies)$/, 'y').replace(/(?:es|s)$/, '').slice(0, 7)

export function quoteSupports(kind: string, text: string, quote: string): boolean {
  if (!quote || !text) return false
  const qn = new Set(numbers(quote))
  if (!numbers(text).every(n => qn.has(n))) return false
  const qs = [...new Set(words(quote).map(stem))]
  // A word is carried when its stem is in the quote, or one stem is a prefix (5+ letters) of the other:
  // "Physio" carries "physiotherapy", "SaaS" never carries "salons".
  const has = (w: string) => { const s = stem(w); return qs.some(q => q === s || (Math.min(q.length, s.length) >= 5 && (q.startsWith(s) || s.startsWith(q)))) }
  const tw = words(text).filter(w => !/^\d/.test(w))
  if (kind === 'location') return tw.length > 0 && tw.every(has)
  const specific = tw.filter(w => !GENERIC.has(w))
  const need = specific.length ? specific : tw
  // A size claim made only of numbers plus generic words ("10-50 employees") is backed by its numbers alone.
  if (kind === 'size' && specific.length === 0 && numbers(text).length > 0) return true
  return need.some(has)
}

// Offer citation binding (#872), a narrow ACCEPTED first-party grammar. Anything unrecognized fails closed to a
// hypothesis - this is an acceptlist, not a growing denylist. An offer is source-backed only when a sentence of the
// quote meets ALL of:
// - the offer's WHOLE name (consecutive full-stem-equal tokens, no prefix bleed - "PayrollPlus" never carries
//   "Payroll") is sentence-initial or follows a first-party OPENER ("our", "our offer is", "we built") - never
//   embedded in someone else's clause ("a reviewer wrote that X runs...", "customers say X...", "we cannot offer
//   X", "our customers buy X from another vendor");
// - a POSITIVE predicate lands immediately on the name: an acceptlisted verb ("X runs payroll for clinics") or a
//   copula + acceptlisted first-party complement ("X is our flagship product", "X is available"). A bare copula
//   with anything else ("X is a product sold exclusively by another vendor") is not a claim;
// - POLARITY is exact: a negator between the name and the predicate, or anywhere after it in the sentence, voids
//   the sentence ("X does not run payroll", "X is not our product", "X is no longer sold");
// - the quote names exactly ONE offer (a sentence naming two offers sources neither), with no comparison,
//   third-party subject, or testimonial attribution anywhere in it.
// quoteSupports alone is NOT enough for identity: its one-distinctive-word rule admits a sibling product sharing a
// brand word and reads neither polarity nor attribution.
const COMPARISON = /\b(?:unlike|versus|vs\.?|compared (?:to|with)|alternative to|instead of|rather than|better than|cheaper than)\b/i
const ATTRIBUTION = /(?:^|\s)[-–—]\s*\p{Lu}[\p{L}'.-]*(?:\s+\p{Lu}[\p{L}'.-]*){0,3}\s*$/u
// ONE quote contract (#872): the same cap at construction (seller-research.ts), storage and ingress (icp.ts).
// An over-cap quote is REJECTED, never sliced - a slice can cut off the negation or attribution that changes the claim.
export const MAX_RESEARCH_QUOTE = 300
// A customer or other third party as the claim's subject: their purchase or praise is not the seller's own statement.
const THIRD_PARTY = /\b(?:customers?|clients?|users?|buyers?|patients?|companies|they|people)\s+(?:[\p{L}']+\s+){0,4}(?:buy|bought|purchase[sd]?|use[sd]?|say|said|chose|choose|prefer(?:red)?|love[sd]?|left|switch(?:ed)?|got|get|found|report(?:ed)?)\b/iu
const tokens = (s: string) => norm(s).split(' ').filter(Boolean)
// The name's tokens, stem-equal and CONSECUTIVE in the quote's tokens; no prefix extension ("payrollplus" != "payroll").
// Uses a FULL stem - the shared stem() truncates to 7 letters for word-carriage, which would bleed prefixes here.
const stemFull = (w: string) => w.replace(/(?:ies)$/, 'y').replace(/(?:es|s)$/, '')
function nameSubject(name: string, qtoks: string[]): number {
  const nt = tokens(name); if (!nt.length) return -1
  for (let i = 0; i + nt.length <= qtoks.length; i++) if (nt.every((w, j) => stemFull(qtoks[i + j]) === stemFull(w))) return i
  return -1
}
// Shared ownership core: this offer's whole name is present, no OTHER offer's whole name is - exactly one owner,
// or the claim cannot be attributed (a sentence naming two offers sources neither).
function offerOwnership(name: string, quote: string, otherNames: string[]): boolean {
  const qtoks = tokens(quote)
  if (nameSubject(name, qtoks) < 0) return false
  return !otherNames.some(o => norm(o) !== norm(name) && nameSubject(o, qtoks) >= 0)
}
// A quote's sentences WITH their terminal punctuation: the grammar binds name, predicate, polarity and segment
// within ONE sentence, and only a DECLARATIVE sentence ('.' or, at quote level, no terminal) can source a claim -
// never a question or an exclamation.
const sentences = (s: string): { body: string; term: string }[] => (s.replace(/\n+/g, ' ').match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? []).map(x => { const m = x.trim(); const t = m.match(/[.!?]+$/)?.[0] ?? ''; return { body: t ? m.slice(0, -t.length) : m, term: t.slice(-1) } }).filter(x => x.body)
// Positive first-party predicates. A verb not in this list is not a claim; a claim not recognized is a hypothesis.
const POS_VERB = new Set('runs lets helps gives offers provides includes costs starts makes automates sends fills saves supports handles delivers simplifies serves'.split(' '))
// After a copula, only an explicit FIRST-PARTY possessive counts ("X is our payroll product"). A bare
// "available"/"designed" is NOT ownership ("available exclusively from another vendor", "designed and sold by
// our competitor", "available if we ever build it") and stays a hypothesis.
const COPULA_COMPLEMENT = new Set(['our'])
// Hypothetical or conditional modality after the name ("available if we ever build it", "would run payroll")
// is not a claim of fact: the sentence is unrecognized and fails closed.
const CONDITIONAL = new Set(['if', 'would', 'could', 'might', 'may', 'should'])
// Reported speech: the citation is itself quoted material or carries a reporting clause ("..." says Harbor
// Dental / according to G2) - someone else's words about the offer, never the seller's authored page copy.
export const REPORTED = /["“”]|\b(?:says|said|writes|wrote|according to)\s+\p{Lu}/u
// A testimonial/review announcement: what follows is a customer's story, not the seller's own claim.
export const ANNOUNCE = /\b(?:testimonials?|case[-\s]?stud(?:y|ies)|success[-\s]?stor(?:y|ies)|(?:customer|client|user)s?\s+reviews?|what\s+(?:our\s+)?(?:customers?|clients?|users?)\s+say)\b/i
// Sentence-openers that keep the name first-party. Anything else before the name embeds it in another clause.
// LEAD_IN keeps the name the SUBJECT (a positive predicate must follow it); OFFERING is an explicit first-party
// OWN-offering construction with the name as its OBJECT ("we offer X", "our offer is X") - exact and complete, so
// "we cannot offer X" and "our customers buy X" never match.
const LEAD_IN = new Set(['', 'the', 'our', 'our flagship', 'introducing', 'meet'])
const OFFERING = new Set(['we offer', 'we sell', 'we make', 'we build', 'we built', 'we provide', 'we ship', 'we run', 'we automate', 'we support', 'we deliver', 'we host', 'our offer is', 'our product is'])
// External ownership: the sentence hands the offer to someone else ("our competitor's payroll product", "sold by
// another vendor"). Offer citations only - a disqualifier may legitimately exclude third parties.
const EXTERNAL = /\b(?:competitors?|another (?:vendor|provider|company|seller)|third[- ]party|other (?:vendors?|providers?|companies|compan(?:y|ies)|sellers?)|someone else)\b/i
// Negation: a bare negator, or the two tokens norm() makes of a contraction ("don't" -> "don t"). 'without' is
// deliberately NOT here ("runs payroll for clinic owners without a finance team" is a true positive).
const NEGATOR = new Set(['not', 'no', 'never', 'nor', 'neither', 'cannot', 'hardly', 'barely'])
const CONTRACTION = /^(?:don|doesn|didn|won|can|couldn|isn|aren|wasn|weren|hasn|haven|hadn|mustn|shouldn|wouldn)$/
const isNeg = (toks: string[], i: number) => NEGATOR.has(toks[i]) || (CONTRACTION.test(toks[i]) && toks[i + 1] === 't')
type OfferVerdict = 'positive' | 'negative' | 'none'
function offerSentence(name: string, stoks: string[]): OfferVerdict {
  const at = nameSubject(name, stoks)
  if (at < 0) return 'none'
  const before = stoks.slice(0, at).join(' ')
  const rest = stoks.slice(at + tokens(name).length)
  if (OFFERING.has(before)) {
    // The name is the object of our own offering construction; polarity still holds across the whole sentence.
    for (let i = 0; i < rest.length; i++) {
      if (isNeg(rest, i)) return 'negative'
      if (CONDITIONAL.has(rest[i])) return 'none'
    }
    return 'positive'
  }
  if (!LEAD_IN.has(before)) return 'none'   // embedded in another clause: not the seller's own claim
  if (!rest.length) return 'none'
  if (isNeg(rest, 0)) return 'negative'
  let positive = false
  if (POS_VERB.has(rest[0])) positive = true
  else if ((rest[0] === 'is' || rest[0] === 'are') && rest[1] !== undefined) {
    if (isNeg(rest, 1)) return 'negative'
    positive = COPULA_COMPLEMENT.has(rest[1])
  }
  if (!positive) return 'none'
  for (let i = 1; i < rest.length; i++) {
    if (isNeg(rest, i)) return 'negative'   // polarity holds across the sentence
    if (CONDITIONAL.has(rest[i])) return 'none'   // hypothetical, not a claim of fact
  }
  return 'positive'
}
export function quoteBacksOffer(name: string, quote: string, otherNames: string[] = []): boolean {
  if (!name || !quote) return false
  if (!offerOwnership(name, quote, otherNames)) return false
  if (COMPARISON.test(quote) || ATTRIBUTION.test(quote) || THIRD_PARTY.test(quote) || REPORTED.test(quote) || ANNOUNCE.test(quote) || EXTERNAL.test(quote)) return false
  let positive = false
  for (const s of sentences(quote)) {
    const v = offerSentence(name, tokens(s.body))
    if (v === 'negative') return false
    if (v === 'positive' && (s.term === '.' || s.term === '')) positive = true
  }
  return positive
}

// Disqualifier citation binding (#872): an EXPLICIT exclusion clause bound to the SAME offer and to the CLAIMED
// segment, token-for-token. The quote must name the offer (exact identity, exactly one owner) and state a negative
// availability predicate with the offer as subject ("Acme Booking is not available for clinics with over 50
// staff"), where the predicate's OBJECT equals the claim text - full-stem token equality, so the comparator and
// the number are part of the binding ("under 50" never backs an "over 50" claim, "dental clinics" never backs
// "Texas clinics"). A positive availability for the same segment anywhere in the sentence vetoes the exclusion
// ("not available for dental clinics, but available for Texas clinics"). A pricing boundary, an "only" mention, a
// positive inclusion of the segment, or the OTHER offer's exclusion never sources it.
const NEG_AVAIL = 'is not available for|is unavailable for|are not available for|are unavailable for|is not for|is not intended for|is not designed for|is not suitable for|is not built for|is not made for|is not offered to|are not offered to|does not serve|do not serve|does not support|do not support|does not fit|cannot serve|cannot support|excludes'.split('|')
const POS_AVAIL = 'is available for|are available for|is designed for|is built for|is made for|is suitable for|is intended for|is offered to|is for|serves|supports'.split('|')
const CLAUSE_END = new Set(['but', 'however', 'though', 'although', 'yet', 'while'])
const segEq = (a: string[], b: string[]) => a.length === b.length && a.every((w, i) => stemFull(w) === stemFull(b[i]))
export function quoteBacksDisqualifier(offerName: string, text: string, quote: string, otherNames: string[] = []): boolean {
  if (!offerName || !text || !quote) return false
  if (!offerOwnership(offerName, quote, otherNames)) return false
  if (COMPARISON.test(quote) || ATTRIBUTION.test(quote) || THIRD_PARTY.test(quote) || REPORTED.test(quote) || ANNOUNCE.test(quote)) return false
  const claim = tokens(text)
  if (!claim.length) return false
  let excluded = false, included = false
  for (const s of sentences(quote)) {
    const stoks = tokens(s.body)
    const at = nameSubject(offerName, stoks)
    if (at < 0 || !LEAD_IN.has(stoks.slice(0, at).join(' '))) continue   // the offer must be this sentence's subject
    const rest = stoks.slice(at + tokens(offerName).length)
    const objectAfter = (pt: string[], from: number) => {
      const obj = rest.slice(from + pt.length)
      const cut = obj.findIndex(w => CLAUSE_END.has(w))
      return cut < 0 ? obj : obj.slice(0, cut)
    }
    for (const p of NEG_AVAIL) {
      const pt = p.split(' ')
      if (pt.every((w, i) => rest[i] === w) && segEq(objectAfter(pt, 0), claim) && (s.term === '.' || s.term === '')) excluded = true
    }
    // A positive availability for the claimed segment - even in a later elided-subject clause - vetoes the exclusion.
    for (const p of POS_AVAIL) {
      const pt = p.split(' ')
      for (let i = 0; i + pt.length <= rest.length; i++) if (pt.every((w, j) => rest[i + j] === w) && segEq(objectAfter(pt, i), claim)) included = true
    }
  }
  return excluded && !included
}
