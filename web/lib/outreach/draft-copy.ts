// #1710: the draft composer. The old template (draftTemplate in service.ts) pasted system wording into the
// email: the address page URL, a "Saved excerpt from this public page:" block with the source URL, and the
// seller's stored profile line after "About <name>:". This composer writes the same facts as a short
// personal note instead:
//
// - The lead's saved signal/excerpt is referenced in prose, in plain words (no quotation marks, no URL):
//   provenance stays in the product UI, not in the prospect's inbox.
// - The seller's offer becomes a sentence ("At dazl, we offer ..." / "we find ..."), never a pasted profile
//   line, and nothing is added to it: literal seller-authored context only, no inferred need, no claimed
//   pain, no personal detail the page did not publish (the template's standing rules).
// - One ask and the same sign-off contract as the template ("Thanks," — the send
//   footer adds the sender's name).
// - Quoted text is cut at a sentence end when one fits the budget, never mid-clause, and an
//   all-caps source line is sentence-cased, so no paste dangles unfinished or shouts.
//
import { eventDayVerified } from '../scan/scoreboard.ts'
import { evidenceStateOf } from './evidence-state.ts'

export interface DraftCopyLead {
  name?: string | null
  company?: string | null
  signal?: string | null
  evidence_excerpt?: string | null
  confidence?: number | null
  human_confirmed_at?: number | null
  review_reason?: string | null
  event_date?: string | null
  event_date_proof?: string | null
  signal_kind?: string | null
}

export class DraftCopyError extends Error {
  code: 'seller_context_required' | 'seller_offer_required'
  constructor(code: 'seller_context_required' | 'seller_offer_required') {
    super(code)
    this.name = 'DraftCopyError'
    this.code = code
  }
}

// URLs are stripped, not just the source_url field (Qodo): an excerpt or profile line can carry one
// inline ("Hiring details: https://..."), and no URL of any kind belongs in the draft. The composer
// paraphrases in plain words rather than quoting, so removing a URL token does not falsify a quote.
// A record can carry diagnostic lines alongside real evidence or offer text.
// Omit the entire contaminated line so a fragment cannot become a new claim.
const SYSTEM_LINE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b(?:HTTP(?:\/\d(?:\.\d)?)?\s+|(?:status|error)\s*[:=]\s*)[1-5]\d\d\b|[{}]|^\s*\[\s*["\d\]]|saved excerpt|contact address published|^\s*about [^:]+:/i
// A source line shouted in full caps pastes a log into the inbox. When a line is entirely
// uppercase, sentence-case it: tokens with digits (B2B) are kept, everything else is lowercased,
// and the line keeps one initial capital. A line with any lowercase letter is left alone, so
// mixed-case text (proper nouns, acronyms) survives untouched.
const shouty = (line: string): string => {
  const letters = line.replace(/[^a-zA-Z]/g, '')
  if (letters.length < 6 || letters !== letters.toUpperCase()) return line
  const out = line.split(/\s+/).map(w => (/\d/.test(w) ? w : w.toLowerCase())).join(' ')
  const i = out.search(/[a-zA-Z]/)
  return i === -1 ? out : out.slice(0, i) + out[i].toUpperCase() + out.slice(i + 1)
}
const clean = (s: string, max: number, prose = false) => s.replace(/https?:\/\/\S+/gi, ' ').replace(/\bwww\.\S+/gi, ' ')
  .split(/\r\n?|\n/).map(line => prose ? shouty(line) : line).filter(line => !SYSTEM_LINE.test(line)).join(' ')
  .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').replace(/^[\s:;,.-]+/, '').trim().slice(0, max)
// Cut quoted prose at a sentence end when one fits the word budget, so a fragment never dangles
// mid-clause in the draft ("...founders who have sold."). Only when no sentence end fits does it
// fall back to a word-boundary cut with an ellipsis, which the caller strips with the trailing dots.
const cutProse = (s: string, maxWords: number): string => {
  const w = s.split(/\s+/).filter(Boolean)
  if (w.length <= maxWords) return s
  const budget = w.slice(0, maxWords).join(' ')
  let end = Math.max(budget.lastIndexOf('. '), budget.lastIndexOf('! '), budget.lastIndexOf('? '))
  if (/[.!?]$/.test(budget)) end = Math.max(end, budget.length - 1)
  return end > budget.length * 0.4 ? budget.slice(0, end + 1).trim() : `${budget}...`
}
const lowerFirst = (s: string) => /^[A-Z](?:[a-z]|\s|$)/.test(s) ? s[0].toLowerCase() + s.slice(1) : s
// lowerFirst softens a quoted sentence that starts mid-thought, but it must never lowercase the
// company's own name ("Peerbound announced..." must not become "peerbound announced...").
const lowerFirstSafe = (s: string, company: string): string => {
  const word = (t: string) => (t.split(/[\s,]+/)[0] ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const first = word(s)
  return first && first === word(company) ? s : lowerFirst(s)
}

// Offer lines that open with a verb read as "we <verb> ..."; a noun phrase forced into that frame reads
// broken ("we sales prospecting software"), so only a known offer verb takes the verb frame. The set
// holds base forms only (Qodo): a third-person opener ("Helps sales teams...") is recognised by
// stripping its s/es suffix back to a base form in the set, and the base form is what follows "we" —
// never "we helps".
const OFFER_VERBS = new Set(('find help build make create sell provide deliver run grow automate connect turn give write design develop launch manage book source generate convert capture track simplify power enable bring get take keep cut boost drive handle serve support offer supply produce craft match reach close fill hire').split(' '))
const baseVerb = (w: string): string | null => {
  if (OFFER_VERBS.has(w)) return w
  if (w.endsWith('es') && OFFER_VERBS.has(w.slice(0, -2))) return w.slice(0, -2)
  if (w.endsWith('s') && OFFER_VERBS.has(w.slice(0, -1))) return w.slice(0, -1)
  return null
}

// The stored offer is a profile line, not a sentence. Frame it without adding claims:
// "we ..." stays a we-sentence; a verb-led line becomes "we <verb> ..."; anything else is something the
// seller offers ("we offer <line>").
function offerSentence(name: string, offer: string): string {
  const o = cutProse(offer, 35).replace(/\.+$/, '')
  if (/^we\b/i.test(o)) return `At ${name}, ${lowerFirst(o)}.`
  if (/^(a|an|the)\b/i.test(o)) return `At ${name}, we offer ${lowerFirst(o)}.`
  const [firstRaw, ...rest] = o.split(' ')
  const base = baseVerb((firstRaw ?? '').toLowerCase().replace(/[^a-z]/g, ''))
  if (base) return `At ${name}, we ${base}${rest.length ? ` ${rest.join(' ')}` : ''}.`
  return `At ${name}, we offer ${lowerFirst(o)}.`
}

export function composeDraftCopy(lead: DraftCopyLead, businessName: string, positioning = ''): { subject: string; body: string } {
  const name = clean(businessName, 150)
  if (!name) throw new DraftCopyError('seller_context_required')
  // A legacy profile may label the seller's own offer. Strip that heading only from
  // the offer input, then apply the same diagnostic filter to the remaining text.
  const heading = `about ${name.toLowerCase()}:`
  const profile = positioning.trimStart()
  const offer = clean(profile.toLowerCase().startsWith(heading) ? profile.slice(heading.length) : profile, 600, true)
  if (!offer) throw new DraftCopyError('seller_offer_required')
  const contactName = clean(lead.name ?? '', 150)
  const who = contactName.split(' ')[0] || 'there'
  const company = lead.company ? clean(lead.company, 150) : ''
  // Only the machine-checked source excerpt supports a factual opener.
  const evidence = {
    evidence_excerpt: lead.evidence_excerpt ?? null,
    confidence: lead.confidence ?? null,
    human_confirmed_at: lead.human_confirmed_at ?? null,
  }
  const excerpt = !lead.review_reason && evidenceStateOf(evidence) === 'machine' ? evidence.evidence_excerpt ?? '' : ''
  const seen = cutProse(clean(excerpt, 400, true), 40).replace(/\.+$/, '')
  const signalDay = seen && lead.event_date && eventDayVerified(lead)
    ? new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(lead.event_date))
    : null
  const opener = !seen
    ? `I came across ${company || 'your company'} and thought it was worth writing directly.`
    : signalDay
      ? `I saw that on ${signalDay}, ${company && seen.startsWith(company) ? seen : lowerFirstSafe(seen, company)}.`
      : company && seen.startsWith(company)
        ? `I saw ${seen}.`
        : `I saw that ${lowerFirstSafe(seen, company)}.`
  return {
    subject: `Quick question for ${company || contactName || 'you'}`.slice(0, 150),
    body: `Hi ${who},\n\n${opener}\n\n${offerSentence(name, offer)}\n\nOpen to a quick chat?\n\nThanks,`,
  }
}
