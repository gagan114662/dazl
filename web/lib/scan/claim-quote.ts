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
// the quote carries the offer's whole name, no OTHER offer's whole name, and none of the contexts where a name on the
// page is not the seller's own claim: a negated offering ("we don't offer X anymore"), a comparison ("Unlike X, ..."),
// an attributed customer testimonial ("... - Harbor Dental"), or a bare label/headline with no prose predicate.
// quoteSupports alone is NOT enough for identity: its one-distinctive-word rule admits a sibling product sharing a
// brand word, and it cannot read polarity or attribution. Every guard here is a necessary condition and none is
// proof on its own; anything short of all of them stays a hypothesis (fail closed).
const NEG_OFFER = /\b(?:don'?t|do not|doesn'?t|does not|never|no longer|stopped?|dropp?ed|discontinued?|retired?)\s+(?:[\p{L}]+\s+){0,3}(?:offer|offers|offered|sell|sells|sold|provide|provides|provided|carry|carries|support|supports|make|makes|include|includes|ship|ships)\b/iu
const COMPARISON = /\b(?:unlike|versus|vs\.?|compared (?:to|with)|alternative to|instead of|rather than|better than|cheaper than)\b/i
const ATTRIBUTION = /(?:^|\s)[-–—]\s*\p{Lu}[\p{L}'.-]*(?:\s+\p{Lu}[\p{L}'.-]*){0,3}\s*$/u
export function quoteBacksOffer(name: string, quote: string, otherNames: string[] = []): boolean {
  if (!name || !quote) return false
  const qs = [...new Set(words(quote).map(stem))]
  const allIn = (n: string): boolean => {
    const tw = words(n); if (!tw.length) return false
    return tw.every(w => { const s = stem(w); return qs.some(q => q === s || (Math.min(q.length, s.length) >= 5 && (q.startsWith(s) || s.startsWith(q)))) })
  }
  // Exactly one current offer's whole name is carried: a sentence naming two offers cannot attribute its claim to one.
  if (!allIn(name) || otherNames.some(o => norm(o) !== norm(name) && allIn(o))) return false
  if (NEG_OFFER.test(quote) || COMPARISON.test(quote) || ATTRIBUTION.test(quote)) return false
  // A claim has prose around the name; a navigation label or bare headline is title-case only and is not a predicate.
  return quote.split(/\s+/).filter(w => /^\p{Ll}[\p{Ll}'-]+$/u.test(w) && !STOP.has(norm(w))).length >= 2
}
