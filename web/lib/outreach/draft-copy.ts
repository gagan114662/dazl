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
//   all-caps source line is sentence-cased (short abbreviations keep their caps), so no paste
//   dangles unfinished or shouts.
// - A signal the composer restructures (a long sentence's main clause) opens as "I saw the <date>
//   news that <clause>.", a headline-shaped fragment ("Company to Move ...") is never pasted, and
//   a recognisable signal kind (hiring, funding, a move, a launch) gains a one-clause bridge that
//   ties the offer to why that moment matters.
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
// uppercase, sentence-case it: digits are never touched, and short abbreviations keep their caps
// (IBM, US, AE, SDR, CRM) so brands and abbreviations survive; only common short English words
// and longer shouting words come down. A line with any lowercase letter is left alone, so
// mixed-case text (proper nouns, acronyms) survives untouched.
const CAP_WORDS = new Set('a an the and or but not no so if of to in on at by for as is are am be was has had can may get we our he she his her him you i me my its it all any few out off now one two own old new end per via up do go who why how too'.split(' '))
const shouty = (line: string): string => {
  const letters = line.replace(/[^a-zA-Z]/g, '')
  if (letters.length < 6 || letters !== letters.toUpperCase()) return line
  const out = line.split(/\s+/).map(w => {
    if (/\d/.test(w)) return w
    const bare = w.replace(/[^a-zA-Z]/g, '')
    if (bare.length === 1) return bare === 'I' ? w : w.toLowerCase()
    if (bare.length <= 3 && !CAP_WORDS.has(bare.toLowerCase())) return w
    return w.toLowerCase()
  }).join(' ')
  const i = out.search(/[a-zA-Z]/)
  return i === -1 ? out : out.slice(0, i) + out[i].toUpperCase() + out.slice(i + 1)
}
const clean = (s: string, max: number, prose = false) => s.replace(/https?:\/\/\S+/gi, ' ').replace(/\bwww\.\S+/gi, ' ')
  .split(/\r\n?|\n/).map(line => prose ? shouty(line) : line).filter(line => !SYSTEM_LINE.test(line)).join(' ')
  .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').replace(/^[\s:;,.-]+/, '').trim().slice(0, max)
// Cut quoted prose at a sentence end when one fits the word budget, so a fragment never dangles
// mid-clause in the draft ("...founders who have sold."). Only when no sentence end fits does it
// fall back to a word-boundary cut with an ellipsis, which the caller strips with the trailing dots.
// A period that closes a title or abbreviation (Dr., Inc., St.) is not a sentence end, so the cut
// never strands "under the direction of Dr." mid-thought; with no real sentence end left in the
// budget the cutter falls back to its word-boundary cut.
const NOT_SENTENCE_END = /(?:^|[\s(])(?:dr|mr|mrs|ms|prof|sr|jr|st|vs|etc|e\.g|i\.e|inc|ltd|corp|co|dept|univ|ave|blvd|fig|no|vol|approx|mt|ft)\.$/i
const cutProse = (s: string, maxWords: number): string => {
  const w = s.split(/\s+/).filter(Boolean)
  if (w.length <= maxWords) return s
  const budget = w.slice(0, maxWords).join(' ')
  const ends = [...budget.matchAll(/[.!?](?=\s|$)/g)].map(m => m.index!)
  for (let i = ends.length - 1; i >= 0; i--) {
    const end = ends[i]
    if (end <= budget.length * 0.4) break
    if (NOT_SENTENCE_END.test(budget.slice(0, end + 1))) continue
    return budget.slice(0, end + 1).trim()
  }
  return `${budget}...`
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
// #1710 (Quest's Nov 27 live check): the composer glued the saved excerpt onto "I saw that on
// <date>," so a press-release headline pasted as grammar ("Company to Move ...") and a long news
// sentence pasted whole. The signal now renders from the excerpt's own words, kept verbatim: the
// first sentence, and for a long one only its main clause (cut at the first subordinating
// boundary). A fragment with no finite clause and a sentence with no clean cut are not pasted at
// all; the caller names the dated news instead. Nothing is added and no facts are invented.
const LEADING_DATE = /^(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:,\s*\d{4})?,?\s+/i
const SUB_WORD = /^(?:after|before|when|while|although|though|because|since|following|amid|despite|which|who|whose|where)$/i
const REPORTING_TAIL = /^(?:that|said|says|told|noted|added|warned|showed|show|revealed|reported|stated|declared|confirmed|denied|denies|announced|explained|insisted|admitted|argued|believes|expects|predicts|suggests|suggested|disclosed|claims|claim)$/i
// A relative-clause cut ("X and Y, which have ...") often strands the subject without a
// predicate (CodeRabbit): the retained words name companies, not a clause. A relative cut is
// kept only when the retained words already read as a clause with a finite verb.
const RELATIVE_WORD = /^(?:which|who|whose|where)$/i
const CLAUSE_VERB = /\b(?:is|are|was|were|be|been|has|have|had|will|would|can|could|announc\w*|said|says|say|show\w*|revealed|report\w*|confirm\w*|open\w*|launch\w*|acquir\w*|rais\w*|hir\w*|mov\w*|won|sign\w*|publish\w*|unveil\w*|complet\w*|expand\w*|secur\w*|began|begin|start\w*|plan\w*|agre\w*|appoint\w*|doubl\w*|grew|grow\w*|becam\w*|becom\w*|lead\w*|led|serv\w*|offer\w*|provid\w*|deliver\w*|operat\w*|run\w*|mak\w*|build\w*|sell\w*|creat\w*|add\w*|introduc\w*|debut\w*|enter\w*|filed)\b/i
const HEADLINE_SHAPE = /^(?:[A-Z][\w'’&.-]*[\s,]+){1,4}[Tt]o\s+[A-Z]/
const HEADLINE_SHAPE_SOFT = /^(?:[A-Z][\w'’&.-]*[\s,]+){2,4}[Tt]o\s+[a-z]+\s+[A-Z0-9]/
// An all-caps source headline: word TO word, checked on the raw excerpt only (the cleaned text
// is sentence-cased and its capitals are gone).
const HEADLINE_SHAPE_SHOUT = /\b\S+\s+TO\s+\S+/
const allCaps = (t: string): boolean => { const letters = t.replace(/[^a-zA-Z]/g, ''); return letters.length >= 6 && letters === letters.toUpperCase() }
function firstSentenceOf(text: string): string {
  const words = text.split(/\s+/).filter(Boolean)
  for (let i = 0; i < words.length; i++) {
    if (/[.!?]$/.test(words[i]) && !/^[A-Za-z]\.$/.test(words[i]) && !NOT_SENTENCE_END.test(words.slice(0, i + 1).join(' '))) return words.slice(0, i + 1).join(' ')
  }
  return text
}
// A kept clause needs at least five words so a cut never strands a stub; an uncuttable long
// sentence returns no text at all rather than a fragment or an ellipsis.
function signalClause(raw: string): { text: string; kept: boolean } {
  const t = raw.replace(LEADING_DATE, '').trim()
  const fs = firstSentenceOf(t)
  const words = fs.split(/\s+/).filter(Boolean)
  if (words.length <= 26) return { text: fs.replace(/\.+$/, ''), kept: true }
  for (let i = 5; i < words.length - 3; i++) {
    const bare = words[i].replace(/[.,;:]$/, '')
    const isSub = SUB_WORD.test(bare) || (bare === 'and' && /,$/.test(words[i - 1]))
    if (!isSub || REPORTING_TAIL.test(words[i - 1].replace(/[.,;:]$/, ''))) continue
    const clause = words.slice(0, i).join(' ').replace(/[,;:]$/, '').trim()
    if (RELATIVE_WORD.test(bare) && !CLAUSE_VERB.test(clause)) continue
    if (clause.split(/\s+/).length >= 5) {
      // Boundaries scanned later yield longer clauses, so the first valid cut is the
      // shortest; past the 26-word budget nothing shorter exists and nothing is pasted.
      if (clause.split(/\s+/).length > 26) return { text: '', kept: false }
      return { text: clause, kept: false }
    }
    break
  }
  return { text: '', kept: false }
}
// The signal kind decides the bridge (general English categories read from the signal's own
// words, never a company, place or query). Hiring wins over funding: the roles being created
// are the fact a sender can act on. The bridge adds no fact about the prospect.
const KIND_BRIDGE = {
  hiring: 'A hiring push like that is exactly when outside help pays off.',
  funding: 'New funding usually means a busy stretch, and that is when outside help pays off.',
  move: 'A move like that means a long list of things to set up, and that is when outside help pays off.',
  launch: 'A launch like that brings a spike of attention, and that is when outside help pays off.',
} as const
const SIGNAL_KINDS: [RegExp, keyof typeof KIND_BRIDGE][] = [
  [/\b(?:hir(?:e|es|ing|ed)|recruit\w*|new roles|headcount|jobs?|vacanc\w*|positions?)\b/i, 'hiring'],
  // "opening" alone names any kind of opening (an office opening is a move); it reads as
  // hiring only with a staffing object nearby (CodeRabbit).
  [/\bopen(?:ing|ings)\b[^.;]{0,40}?\b(?:job|jobs|role|roles|position|positions|staff|hire|hiring|career|careers|employee)\b/i, 'hiring'],
  // Weak action verbs read as hiring only with a staffing object nearby (CodeRabbit):
  // "added a glossary" is not a hiring event, "added 10 new roles" is.
  [/\b(?:added|adding|adds|is creating)\b[^.;]{0,60}?\b(?:roles?|jobs?|staff|people|headcount|team\w*|position\w*|sdr\w*|engineers?|salespeople|hire\w*|recruit\w*|technicians?|operators?|workers?)\b/i, 'hiring'],
  [/\b(?:funding|funded|funds|invest(?:s|ed|ing|ment)(?:s)?)\b/i, 'funding'],
  // "raised" alone names any kind of raising (prices, a flag); it reads as funding only
  // with fundraising context nearby (CodeRabbit).
  [/\brais(?:e|es|ed|ing)\b[^.;]{0,40}?\b(?:fund(?:ing|s|rais\w*)|series\s+[abc]\b|seed|investment|invest\w*|round|capital|valuation)\b/i, 'funding'],
  [/\b(?:mov(?:e|es|ed|ing)|relocat\w*|expand\w*|new (?:office|location|facility|site))\b/i, 'move'],
  // A location noun alone names no event ("published its annual report from its headquarters");
  // it reads as a move only with move, opening or expansion context nearby (CodeRabbit).
  [/\b(?:headquarters|hq|premises)\b[^.;]{0,40}?\b(?:mov\w+|relocat\w*|expand\w*|expansion|open\w*|new (?:office|location|facility|site))\b/i, 'move'],
  [/\b(?:mov\w+|relocat\w*|expand\w*|expansion|open\w*|new (?:office|location|facility|site))\b[^.;]{0,40}?\b(?:headquarters|hq|premises)\b/i, 'move'],
  [/\b(?:launch\w*|unveil\w*|releas\w*|rolls out)\b/i, 'launch'],
]

function offerSentence(name: string, offer: string): string {
  const o = cutProse(offer, 35).replace(/\.+$/, '')
  if (/^we\b/i.test(o)) return `At ${name}, ${lowerFirst(o)}.`
  if (/^(a|an|the)\b/i.test(o)) return `At ${name}, we offer ${lowerFirst(o)}.`
  const [firstRaw, ...rest] = o.split(' ')
  const base = baseVerb((firstRaw ?? '').toLowerCase().replace(/[^a-z]/g, ''))
  if (base) return `At ${name}, we ${base}${rest.length ? ` ${rest.join(' ')}` : ''}.`
  return `At ${name}, we offer ${lowerFirst(o)}.`
}

// Shared stop words for the offer-to-signal word overlap check; a shared filler word is
// not evidence of fit.
const FIT_STOP = new Set(['that', 'this', 'with', 'from', 'about', 'their', 'they', 'have', 'been', 'will', 'when', 'more', 'some', 'only', 'into', 'also', 'than', 'then', 'over', 'after', 'before', 'which', 'your', 'what', 'where', 'would', 'could', 'should', 'there', 'these', 'those', 'other', 'every', 'each'])
const GENERIC_OFFER = /\b(?:software|saas|platform|services?|solutions?|consult\w*|agenc\w*|marketing|sales|advert\w*|tools?|apps?|automation|support|train\w*|design|staff\w*|recruit\w*|account\w*|bookkeep\w*|finance|financial|insur\w*|logistics?|transport\w*)\b/i
// A specialized or equipment-domain offer never rides the generic shortcut (CodeRabbit):
// "services" in "commercial refrigeration maintenance services" does not make it fit any
// business moment; it needs the kind's domain or a shared word with the cited signal.
const SPECIFIC_OFFER = /\b(?:refrigerat\w*|hvac|machin\w*|equipment|industrial|manufactur\w*|automot\w*|dental|medic\w*|clinic\w*|construction|roof\w*|plumb\w*|electric\w*|catering|grocery|restaurant|hospitality|apparel|furniture|farm\w*|agricultur\w*|bakery|forklift\w*|veterinar\w*|legal|salon|realt\w*)\b/i
const KIND_FIT: Record<keyof typeof KIND_BRIDGE, RegExp> = {
  hiring: /\b(?:hir\w*|recruit\w*|talent|jobs?|staff\w*|team\w*|people|headcount|candidate\w*|onboard\w*|payroll|workforce|hr\b|sales)\b/i,
  funding: /\b(?:fund\w*|capital|invest\w*|growth|scal\w*|series|rais\w*|budget|financ\w*|cash|revenue|bank\w*)\b/i,
  move: /\b(?:mov\w*|relocat\w*|office\w*|space|facilit\w*|premises|location\w*|headquarters|site|setup|propert\w*|lease|build\w*|expand\w*|furnish\w*|clean\w*|security|network|phone|internet)\b/i,
  launch: /\b(?:launch\w*|releas\w*|product\w*|feature\w*|customer\w*|market\w*|attention|brand\w*|audience|press|website|web\b|seo|content)\b/i,
}
// True when the seller's offer may claim relevance to the moment the cited signal describes.
function offerFits(kind: keyof typeof KIND_BRIDGE, offer: string, seen: string): boolean {
  if (!SPECIFIC_OFFER.test(offer) && GENERIC_OFFER.test(offer)) return true
  if (KIND_FIT[kind].test(offer)) return true
  const signalWords = new Set((seen.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []).filter(w => !FIT_STOP.has(w)))
  const offerWords = offer.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []
  return offerWords.some(w => signalWords.has(w))
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
  const rawSignal = clean(excerpt, 400, true)
  // The headline guard also reads the excerpt before casing: an all-caps source line reaches the
  // opener sentence-cased, with its interior capitals gone, so the shape check on the cleaned
  // text alone can miss it (Qodo).
  const rawForShape = excerpt.replace(/https?:\/\/\S+/gi, ' ').replace(/\bwww\.\S+/gi, ' ').replace(LEADING_DATE, '').trim()
  const parts = rawSignal ? signalClause(rawSignal) : { text: '', kept: true }
  const seen = parts.text
  const signalDay = lead.event_date && eventDayVerified(lead)
    ? new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(lead.event_date))
    : null
  // A headline-shaped excerpt and a sentence too tangled to cut cleanly are never pasted; the
  // draft references the dated news instead. A signal the composer restructured opens in the
  // natural news frame, and a short unchanged signal keeps the established wording.
  const newsRef = `I saw the ${signalDay ? `${signalDay} ` : 'recent '}news about ${company || contactName || 'your company'}.`
  const cited = company && seen.startsWith(company) ? seen : lowerFirstSafe(seen, company)
  const isHeadline = HEADLINE_SHAPE.test(seen) || HEADLINE_SHAPE_SOFT.test(seen) || HEADLINE_SHAPE.test(rawForShape) || HEADLINE_SHAPE_SOFT.test(rawForShape) || (allCaps(rawForShape) && HEADLINE_SHAPE_SHOUT.test(rawForShape))
  const opener = !seen
    ? rawSignal
      ? newsRef
      : `I came across ${company || 'your company'} and thought it was worth writing directly.`
    : isHeadline
      ? newsRef
      : parts.kept
        ? signalDay
          ? `I saw that on ${signalDay}, ${cited}.`
          : company && seen.startsWith(company) ? `I saw ${seen}.` : `I saw that ${cited}.`
        : signalDay
          ? `I saw the ${signalDay} news that ${cited}.`
          : company && seen.startsWith(company) ? `I saw ${seen}.` : `I saw that ${cited}.`
  // When the signal's kind is recognisable from its own words, a one-clause bridge ties the
  // seller's offer to why that moment matters; the offer keeps its own words and an
  // unrecognisable kind gets no bridge. The kind is read from the text the opener actually
  // cites (the machine-checked excerpt), never from the separately stored lead.signal: a
  // signal field that describes a different event must not select a bridge the draft never
  // mentions. The bridge claims the seller's offer is relevant to that moment, so it is
  // omitted when the claim is unsupported: a generic business offer (software, services,
  // marketing) may claim it for any business moment, while an offer for a specific niche or
  // equipment domain only bridges when its own words share the cited signal's words or the
  // kind's domain. Lexical and conservative on purpose: an unsupported tie reads worse than
  // no tie at all.
  const offerLine = offerSentence(name, offer)
  const kindHit = seen ? SIGNAL_KINDS.find(([re]) => re.test(seen)) : null
  // A negated statement ("is not hiring any new staff") is the absence of the event, not the
  // event; no bridge is selected from it (CodeRabbit). Checking the whole cited clause is the
  // conservative read: it can only suppress a bridge, never add one.
  const kind = kindHit && seen && !/\b(?:not|no|never|without|hardly|won't|isn't|aren't|doesn't|don't|didn't|hasn't|haven't)\b/i.test(seen) ? kindHit[1] : null
  const pitch = kind && offerFits(kind, offer, seen) ? `${KIND_BRIDGE[kind]} ${offerLine}` : offerLine
  return {
    subject: `Quick question for ${company || contactName || 'you'}`.slice(0, 150),
    body: `Hi ${who},\n\n${opener}\n\n${pitch}\n\nOpen to a quick chat?\n\nThanks,`,
  }
}
