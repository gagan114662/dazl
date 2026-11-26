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
// - One ask, the wrong-person escape, and the same sign-off contract as the template ("Thanks," — the send
//   footer adds the sender's name).
//
// It is deliberately not wired into createDraft yet: draftTemplate's call site is in service.ts, which is
// another lane until #1734 merges. The wiring maps DraftCopyError codes onto OutreachError unchanged
// (seller_context_required / seller_offer_required), so refusal behaviour does not move.

export interface DraftCopyLead {
  name?: string | null
  company?: string | null
  signal?: string | null
  evidence_excerpt?: string | null
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
const clean = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/https?:\/\/\S+/gi, ' ').replace(/\bwww\.\S+/gi, ' ').replace(/\s+/g, ' ').replace(/^[\s:;,.-]+/, '').trim().slice(0, max)
const takeWords = (s: string, n: number) => { const w = s.split(/\s+/).filter(Boolean); return w.length <= n ? s : `${w.slice(0, n).join(' ')}...` }
// Trim at a word boundary and mark the cut, so a quoted prefix is never presented as the whole text.
const trimWords = (s: string, max: number) => {
  if (s.length <= max) return s
  const cut = s.lastIndexOf(' ', max)
  return `${s.slice(0, cut > 40 ? cut : max).trimEnd()}...`
}
const lowerFirst = (s: string) => s.length > 1 && /[a-z]/.test(s[1]) ? s[0].toLowerCase() + s.slice(1) : s

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
  const o = takeWords(trimWords(offer, 200), 35).replace(/\.+$/, '')
  if (/^we\b/i.test(o)) return `At ${name}, ${o}.`
  if (/^(a|an|the)\b/i.test(o)) return `At ${name}, we offer ${o}.`
  const [firstRaw, ...rest] = o.split(' ')
  const base = baseVerb((firstRaw ?? '').toLowerCase().replace(/[^a-z]/g, ''))
  if (base) return `At ${name}, we ${base}${rest.length ? ` ${rest.join(' ')}` : ''}.`
  return `At ${name}, we offer ${lowerFirst(o)}.`
}

export function composeDraftCopy(lead: DraftCopyLead, businessName: string, positioning = ''): { subject: string; body: string } {
  const offer = clean(positioning, 600)
  const name = clean(businessName, 150)
  if (!name) throw new DraftCopyError('seller_context_required')
  if (!offer) throw new DraftCopyError('seller_offer_required')
  const who = lead.name ? clean(lead.name, 150).split(' ')[0] : 'there'
  const company = lead.company ? clean(lead.company, 150) : ''
  // The signal in the lead's own saved words: the excerpt when there is one, else the signal claim.
  // Quoted, so it reads as something seen, and it never carries the page URL into the email.
  const seen = takeWords(trimWords(clean(lead.evidence_excerpt || lead.signal || '', 400), 140), 40).replace(/\.+$/, '')
  // Plain words, no quotation marks (Quest): the saved sentence becomes the second half of an "I saw ..."
  // sentence when it opens with the company name; otherwise it follows "on your site that ...". The words
  // themselves are the lead's own — rewording them mechanically would risk inventing a claim.
  const opener = !seen
    ? `I came across ${company || 'your company'} and thought it was worth writing directly.`
    : company && seen.startsWith(company)
      ? `I saw ${seen}.`
      : `I saw on your site that ${lowerFirst(seen)}.`
  return {
    subject: `Quick question for ${company || lead.name || 'you'}`.slice(0, 150),
    body: `Hi ${who},\n\n${opener}\n\n${offerSentence(name, offer)}\n\nWould a short conversation about whether this fits your team's work be useful? If I have the wrong person, could you point me to the right one?\n\nThanks,`,
  }
}
