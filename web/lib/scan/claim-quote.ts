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

// Offer citation binding (#872). An offer is source-backed only by an unambiguous FIRST-PARTY POSITIVE predicate:
// the offer's WHOLE name appears as consecutive, exactly-matched tokens (no prefix bleed - "PayrollPlus" never
// carries "Payroll"), the name is the SUBJECT of a positive predicate ("Acme Payroll runs payroll for clinics"),
// and none of the contexts where a name on the page is not the seller's own claim appears: a negated offering
// ("we don't/cannot offer X", "X is not sold/available"), a comparison ("Unlike X, ..."), third-party words about
// the offer ("customers buy X from another vendor", "customers say X saved hours", an attributed testimonial), or a
// bare label/headline with no predicate ("X information and resources"). quoteSupports alone is NOT enough for
// identity: its one-distinctive-word rule admits a sibling product sharing a brand word and reads neither polarity
// nor attribution. Every condition here is necessary, none is proof alone; anything short of all fails closed.
const NEG_OFFER = /\b(?:don'?t|do not|doesn'?t|does not|cannot|can'?t|couldn'?t|could not|won'?t|will not|never|no longer|stopped?|dropp?ed|discontinued?|retired?|unable to)\s+(?:[\p{L}]+\s+){0,3}(?:offer|offers|offered|sell|sells|sold|provide|provides|provided|carry|carries|support|supports|make|makes|include|includes|ship|ships)\b|\b(?:not|never|no longer)\s+(?:available|offered|provided|supported|for|sold|included|shipped|carried|made|built)\b/iu
const COMPARISON = /\b(?:unlike|versus|vs\.?|compared (?:to|with)|alternative to|instead of|rather than|better than|cheaper than)\b/i
const ATTRIBUTION = /(?:^|\s)[-–—]\s*\p{Lu}[\p{L}'.-]*(?:\s+\p{Lu}[\p{L}'.-]*){0,3}\s*$/u
// A customer or other third party as the claim's subject: their purchase or praise is not the seller's own statement.
const THIRD_PARTY = /\b(?:customers?|clients?|users?|buyers?|patients?|companies|they|people)\s+(?:[\p{L}']+\s+){0,4}(?:buy|bought|purchase[sd]?|use[sd]?|say|said|chose|choose|prefer(?:red)?|love[sd]?|left|switch(?:ed)?|got|get|found|report(?:ed)?)\b/iu
// Positive first-party predicates: the offer named as subject does or is something. A name with no such predicate
// after it (a nav label, a list entry, the object of someone else's sentence) is not a claim.
const FIRST_PARTY_PREDICATE = new Set('is are runs run lets let helps help gives give offers offer provides provide includes include costs cost starts start makes make automates automate sends send fills fill saves save supports support handles handle delivers deliver simplifies simplify built designed made priced comes comes'.split(' '))
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
export function quoteBacksOffer(name: string, quote: string, otherNames: string[] = []): boolean {
  if (!name || !quote) return false
  const qtoks = tokens(quote)
  const at = nameSubject(name, qtoks)
  if (at < 0 || otherNames.some(o => norm(o) !== norm(name) && nameSubject(o, qtoks) >= 0)) return false
  // Subject/predicate: a first-party positive predicate follows the name within three tokens.
  const after = qtoks.slice(at + tokens(name).length, at + tokens(name).length + 3)
  if (!after.some(t => FIRST_PARTY_PREDICATE.has(t))) return false
  if (NEG_OFFER.test(quote) || COMPARISON.test(quote) || ATTRIBUTION.test(quote) || THIRD_PARTY.test(quote)) return false
  // A claim has prose around the name; a title-case-only label is not a predicate.
  return quote.split(/\s+/).filter(w => /^\p{Ll}[\p{Ll}'-]+$/u.test(w) && !STOP.has(norm(w))).length >= 2
}

// Disqualifier citation binding (#872): the OPPOSITE polarity of an offer citation. A disqualifier is source-backed
// only by an EXPLICIT exclusion claim bound to the SAME offer: the quote names that offer (exact token identity,
// exactly one owner), carries the claim's own words/numbers, and states the exclusion outright ("Acme Booking is not
// available for clinics with over 50 staff"). A pricing boundary, an "only" mention, a positive inclusion of the
// same segment, or the OTHER offer's exclusion never sources it. Comparison and third-party words are still refused.
const EXCLUSION = /\b(?:not (?:available|for|intended|designed|suitable|offered|built|made|provided|supported)|doesn'?t (?:serve|support|fit|work for)|do not (?:serve|support)|cannot (?:serve|support)|no (?:support|availability) for|excludes?|not serve)\b/iu
export function quoteBacksDisqualifier(offerName: string, text: string, quote: string, otherNames: string[] = []): boolean {
  if (!offerOwnership(offerName, quote, otherNames)) return false
  if (COMPARISON.test(quote) || ATTRIBUTION.test(quote) || THIRD_PARTY.test(quote)) return false
  return EXCLUSION.test(quote) && quoteSupports('disqualifier', text, quote)
}
