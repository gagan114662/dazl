// Routine buyer questions answered from approved product facts (#406). One inbound email in, one decision out:
//   suppress  an opt-out in any language the reply classifier knows: no answer, no pitch (even after a takeover)
//   pause     the tenant replied in the thread themselves: automation stops for that thread
//   ignore    a message already handled (a duplicate webhook or a retry): nothing is sent twice
//   escalate  anything outside authority or not known: discounts, guarantees, contracts, security reviews, an
//             integration or fact the record does not cover, an unauthenticated sender, a question about the seller's
//             own account, business, people or finances, or a question that is not routine
//   reply     pricing, prerequisites, how to start, limitations or booking, answered only from the versioned facts
// The answer is assembled from the facts alone. The inbound text picks which facts apply and is never copied into the
// reply, so it cannot change what dazl offers, reveal anything outside the facts, or point the answer at another
// account. Exceptions are reported as exceptions, separate from the routine approvals a tenant may still require.
//
// THE DECISION RULE. The message is split into fragments (sentences, clauses, list items, requests). A fragment is
// routine only when all three hold:
//   (a) it is, as a WHOLE, one supported product question or request form (SUPPORTED_FORMS, anchored at both ends: a
//       routine word never vouches for a trailing qualification, "Tell me the price you pay per month" is not "Tell me
//       the price");
//   (b) its subject is the product or the buyer, never the seller: a seller possessive ("your", "dazl's") with a noun
//       that is not a product attribute, or the seller as the agent of anything but offering the product ("you pay",
//       "you use", "you store"), is seller scope and escalates whatever the rest says (sellerScope);
//   (c) every noun phrase in it is an approved-fact noun phrase, which (a) guarantees: the forms are built only from
//       the facts' own nouns (price, plans, setup, key, limits, demo, the known integrations).
// A message is routine only when every fragment is. Several routine questions in one message are answered together; one
// fragment that is not routine escalates the whole message, nothing is answered around it.
import { classifyReply } from '../outreach/replies.ts'

export interface ProductFacts {
  version: string
  pricing: string; prerequisites: string; howToStart: string; limitations: string
  signupUrl: string; bookingUrl: string | null
  knownIntegrations: string[]                 // names the facts can answer about (e.g. Gmail, HubSpot, Pipedrive)
}
export interface AnswerPolicy { cta: 'signup' | 'meeting'; maxAutoReplies: number }
export interface ThreadState {
  authenticatedSender: boolean                // the inbound passed authentication and matches the thread's prospect
  takenOver: boolean                          // the tenant has replied in this thread themselves
  handledMessageIds: string[]
  autoReplies: number
}
export interface Inbound { messageId: string; text: string }

export type Topic = 'pricing' | 'prerequisites' | 'how_to_start' | 'limitations' | 'booking'
export type EscalateReason = 'unauthenticated' | 'authority' | 'unknown_integration' | 'not_routine' | 'reply_limit' | 'negative' | 'sensitive' | 'seller_scope' | 'facts_missing'
export type Decision =
  | { action: 'suppress'; messageId: string }
  | { action: 'pause'; messageId: string }
  | { action: 'ignore'; messageId: string }
  | { action: 'escalate'; messageId: string; reason: EscalateReason; detail?: string }
  | { action: 'reply'; messageId: string; topics: Topic[]; body: string; factsVersion: string }

const TOPIC_ORDER: Topic[] = ['pricing', 'prerequisites', 'how_to_start', 'limitations', 'booking']

// Outside an automated answer's authority, whatever else the message asks.
const AUTHORITY = /\d+\s?%\s?off\b|\b(?:discount|coupon|cheaper|lower price|deal on|free (?:month|months|year)|refund|guarantee[sd]?|promise|sla|contract|msa|dpa|nda|terms|negotiat\w*|invoice terms|net ?30|security (?:questionnaire|review|assessment)|soc ?2|iso ?27001|pen ?test|gdpr agreement|legal)\b/i
// Questions no approved fact answers: where data lives and how it is handled, compliance, bespoke work or support. Always
// escalated, even beside a routine question.
const SENSITIVE = /\b(?:data (?:stored|storage|location|residency|retention|deletion|processing|privacy)|where (?:is|are|do you)\b.*\b(?:stored|store|hosted|host|kept|keep|located)|privacy|personal data|pii|hipaa|gdpr|ccpa|encrypt\w*|on[- ]?prem\w*|self[- ]?host\w*|custom (?:support|development|integration|feature|build)|dedicated (?:support|account manager)|white[- ]?label|resell\w*)\b/i

// (b) SELLER SCOPE, decided structurally, not by a list of secret words.
// 1. A seller possessive followed by a noun phrase. The only nouns the seller may "own" in a routine question are the
//    product's attributes the facts describe. Any other noun after "your" (account, key, Gmail, team, customers, revenue,
//    costs you pay, data, margins, ...) makes the question about the seller: escalate.
const SELLER_POSSESSIVE = /\b(?:your|yours|ur|dazl'?s|the (?:team|company)'s)\s+(?:own\s+)?(?:(?:current|new|latest|standard|basic|pro|paid|free|monthly|yearly|annual|full|exact|complete)\s+)*([a-z][a-z-]*)(?:\s+[a-z][a-z-]*)?/gi
const PRODUCT_ATTRIBUTE = new Set((
  'product tool app service platform software ' +
  'pricing price prices fee fees rate rates plan plans tier tiers subscription subscriptions ' +   // not "your costs": what the seller pays
  'limit limits limitation limitations cap caps requirement requirements prerequisite prerequisites setup onboarding ' +
  'demo demos booking calendar trial sign sign-up signup signup-link link integrations integration docs documentation website homepage'
).split(/\s+/))
// 2. The seller ("you") as the agent of a verb. Offering the product (have, offer, charge, support, integrate, work with)
//    and answering a request (tell, share, send, ...) are the product's business; anything else the seller does (pay,
//    use, spend, store, employ, sign, build, earn, ...) is the seller's own situation: escalate.
const OFFER_VERBS = new Set('have offer charge bill support integrate integrates work connect sync plug provide include allow cover handle do run'.split(' '))
const REQUEST_VERBS = new Set('tell share send give show explain describe list confirm let help walk book schedule point recommend clarify say'.split(' '))
// "you" as an object ("thank you", "contact you", "for you") is not the seller acting.
const OBJECT_POSITION = /\b(?:thank|thanks|appreciate|help|contact|email|mail|call|see|meet|give|send|tell|ask|let|show|reach|hear|told|asked|get|bother|remind|to|for|with|at|from|of|by|about|on|in|and|or)\s+you\s+/gi
const YOU_VERB = /\byou\s+(?:(?:guys|folks|all|also|still|currently|even|please|actually|really|usually|normally)\s+)*(?:(?:able|willing|going|planning|happy|ready)\s+to\s+)?([a-z][a-z']*)/gi
function sellerScope(text: string): string | null {
  const t = text.replace(/[’‘]/g, "'")
  // the head noun decides ("your pricing page" is the pricing; "your Gmail account" is the seller's Gmail); whatever
  // follows an attribute is then held to the supported forms like any other word
  for (const m of t.matchAll(SELLER_POSSESSIVE)) if (!PRODUCT_ATTRIBUTE.has(m[1].toLowerCase())) return m[0].trim()
  const subjectOnly = t.replace(OBJECT_POSITION, ' ')
  for (const m of subjectOnly.matchAll(YOU_VERB)) {
    const verb = m[1].toLowerCase()
    if (OFFER_VERBS.has(verb) || REQUEST_VERBS.has(verb)) continue
    return m[0].trim()
  }
  return null
}

// (a) THE SUPPORTED FORMS. Each is matched against the whole fragment (greetings, "please" and end punctuation removed),
// with the product ("it", "this", "dazl", "the tool", "your product") or the buyer ("I", "we") as its subject. A form
// is built only from the facts' own nouns, so a match also settles (c). Nothing may follow a form: a trailing
// qualification ("... you pay per month", "... for your Gmail", "... for enterprise customers in Germany") is not a match.
const PRODUCT = String.raw`(?:it|this|dazl|the (?:product|tool|app|service|platform)|your (?:product|tool|app|service|platform))`
const PER = String.raw`(?: (?:per|a|each) (?:month|year|user|seat)| monthly| yearly| annually)?`
const FREE = String.raw`(?:is there|do you (?:have|offer)|is there any|do you have any)`
interface Form { topics: Topic[]; re: RegExp }
const q = (topics: Topic[], src: string): Form => ({ topics, re: new RegExp(`^${src}$`, 'i') })
const SUPPORTED_FORMS: Form[] = [
  // pricing
  q(['pricing'], String.raw`(?:what(?:'s| is| are| would be| will be)|how much (?:is|are))(?: the| your| ${PRODUCT}(?:'s)?)? (?:price|prices|pricing|cost|costs|fee|fees|rate|rates|paid plans?|pricing plans?|plans?|subscription|monthly (?:price|cost|fee)|pricing (?:model|structure|plans?))${PER}(?: for ${PRODUCT})?`),
  q(['pricing'], String.raw`how much(?: (?:is|does) ${PRODUCT}(?: cost)?| would ${PRODUCT} (?:be|cost)| do you charge| is it to use)?${PER}`),
  q(['pricing'], String.raw`(?:what|how much) (?:does|would|will) ${PRODUCT} cost${PER}`),
  q(['pricing'], String.raw`how much (?:do|would|will) you charge${PER}`),
  q(['pricing'], String.raw`${FREE} an? free (?:plan|tier|version)`),
  q(['pricing'], String.raw`is (?:it|${PRODUCT}) (?:free|paid|free to use)`),
  q(['pricing'], String.raw`do you (?:charge|bill) (?:per|by the|a) (?:month|year|seat|user|email)`),
  q(['pricing'], String.raw`(?:what|which) plans (?:do you (?:have|offer)|are there|are available)`),
  q(['pricing'], String.raw`(?:pricing|prices|price|cost|costs|rates)(?: (?:details|info|information))?`),
  // prerequisites
  q(['prerequisites'], String.raw`what (?:do|would|will) (?:i|we) need(?: to (?:set (?:it |this |dazl )?up|get started|start|use it|run it|begin))?`),
  q(['prerequisites'], String.raw`what (?:i|we) need(?: to (?:set (?:it )?up|get started|start))?`),
  q(['prerequisites'], String.raw`(?:what|which) (?:api key|ai key|key|keys|account|accounts|mailbox|email account|tools) (?:do|would|will) (?:i|we) need(?: to (?:get started|start|set it up))?`),
  q(['prerequisites'], String.raw`(?:do|will|would) (?:i|we) need (?:my own |our own |an? |my |our )?(?:own )?(?:api key|ai key|key|gmail account|google account|gmail|google workspace|account)`),
  q(['prerequisites'], String.raw`what are the (?:requirements|prerequisites|setup requirements|setup steps)(?: to (?:get started|start))?`),
  q(['prerequisites'], String.raw`(?:what is|what's) (?:required|needed|the setup)(?: to (?:get started|start|set it up))?`),
  q(['prerequisites'], String.raw`is there (?:any |a |much )?setup(?: (?:involved|required|needed))?`),
  // how to start
  q(['how_to_start'], String.raw`how (?:do|can|would|should) (?:i|we) (?:get started|start|begin|sign up|try it|try it out|get set up|get going)(?: with ${PRODUCT})?`),
  q(['how_to_start'], String.raw`(?:what are|what's) the (?:steps|next steps|first steps) to (?:get started|start|sign up)`),
  q(['how_to_start'], String.raw`where (?:do|can) (?:i|we) (?:sign up|start|get started|begin)`),
  q(['how_to_start'], String.raw`${FREE} an? (?:free )?trial`),
  q(['how_to_start'], String.raw`can (?:i|we) (?:try it|try it out|test it|start a trial|trial it)(?: (?:first|for free|before (?:buying|paying)))?`),
  q(['how_to_start'], String.raw`how (?:does|would) (?:onboarding|setup|getting started) work`),
  // limitations
  q(['limitations'], String.raw`how many (?:emails|sends|messages|leads|scans|plays|seats|users|mailboxes|inboxes|contacts) can (?:i|we|it|dazl) (?:send|find|run|use|add|connect|have)(?: (?:a|per|each) (?:day|week|month))?`),
  q(['limitations'], String.raw`(?:what are|are there|what's)(?: the| any| your)? (?:limits|limitations|caps|sending limits|daily limits|send limits|volume limits|limits on (?:sends|emails|leads|volume))`),
  q(['limitations'], String.raw`is there a (?:cap|limit|daily limit|sending limit)(?: on (?:sends|emails|leads|scans|volume))?(?: (?:a|per) (?:day|week|month))?`),
  q(['limitations'], String.raw`(?:is|are) there (?:a |any )?(?:limit|limits|cap) (?:on|to) (?:how many|the number of) (?:emails|sends|messages|leads|contacts|users|seats) (?:i|we|it) can (?:send|have|add|find)(?: (?:a|per) (?:day|week|month))?`),
  q(['limitations'], String.raw`what (?:can't|cannot|doesn't|does not) (?:it|dazl|the product|the tool) do`),
  q(['limitations'], String.raw`(?:what|which) channels (?:does it|do you) (?:support|cover)`),
  // booking
  q(['booking'], String.raw`can (?:i|we) (?:book|get|schedule|set up|have|arrange) a (?:demo|call|meeting|quick call|short call)(?: about (?:it|this))?`),
  q(['pricing', 'booking'], String.raw`can (?:i|we) (?:book|get|schedule|set up|have|arrange) a (?:demo|call|meeting|quick call|short call) about pricing`),
  q(['prerequisites', 'booking'], String.raw`can (?:i|we) (?:book|get|schedule|set up|have|arrange) a (?:demo|call|meeting|quick call|short call) about setup`),
  q(['booking'], String.raw`(?:is it possible|would it be possible) to (?:book|schedule|get) a (?:demo|call|meeting)`),
  q(['booking'], String.raw`(?:i|we)(?:'d| would) (?:like|love) to (?:book|schedule|see|get|have) a (?:demo|call|meeting|walkthrough|quick call)`),
  q(['booking'], String.raw`(?:do you (?:do|offer|have)|can (?:i|we) get) (?:a |live )?demos?`),
  q(['booking'], String.raw`(?:how|where) (?:do|can) (?:i|we) book a (?:demo|call|meeting)`),
]
// A request (share/send/tell/explain..., or "I'd like to know", "wondering about") is routine only when its WHOLE object
// is one of the approved facts, with at most a period qualifier ("per month") or the product as its owner.
const REQUEST_VERB = String.raw`(?:(?:can|could|would|will) you\s+(?:please\s+)?)?(?:share|send|give|show|tell|list|confirm|explain|describe|let (?:me|us) know|(?:i|we)(?:'d| would) (?:like|love|want|need) to (?:know|see|understand|get|have)|(?:i|we) (?:want|need|would like) to (?:know|see|understand)|(?:i'm|i am|we're|we are) (?:curious|interested|wondering) (?:about|in)|(?:just )?wondering about|(?:any|some|more) (?:info|information|details) (?:on|about))\s*(?:(?:me|us)\s+)?(?:(?:over|about)\s+)?`
const OBJECT_HEAD = String.raw`(?:(?:your|the|a|an|some|more|any|${PRODUCT}(?:'s)?)\s+)?(?:(?:details|info|information) (?:on|about) (?:your |the )?)?`
const r = (topics: Topic[], object: string): Form => ({ topics, re: new RegExp(`^${REQUEST_VERB}${OBJECT_HEAD}${object}$`, 'i') })
const REQUEST_FORMS: Form[] = [
  r(['pricing'], String.raw`(?:pricing|prices?|costs?|fees?|rates?|(?:pricing |paid |subscription )?plans?|subscription(?: options)?|monthly (?:price|cost|fee)|pricing (?:details|info|information|page|sheet|model|structure))${PER}(?: for ${PRODUCT})?`),
  r(['prerequisites'], String.raw`(?:setup(?: steps| requirements| process)?|requirements|prerequisites|what (?:i|we) need(?: to (?:set up|get started|start))?)`),
  r(['how_to_start'], String.raw`(?:(?:link|steps|instructions) to (?:sign up|get started|start)|how (?:to|i|we) (?:get started|start|begin|sign up|set (?:it )?up)|sign[ -]?up link|getting started (?:steps|guide|instructions)|onboarding steps)`),
  r(['limitations'], String.raw`(?:limits|limitations|caps|sending limits|daily limits)`),
  r(['booking'], String.raw`(?:demo(?: link)?|booking link|calendar link|a time (?:to talk|for a call|for a demo))`),
]
// Integrations: "does it work with X", "is there an X integration". The names asked are checked against the facts' list.
const INTEGRATION_FORMS: RegExp[] = [
  new RegExp(String.raw`^(?:does|do|can|will|would) (?:${PRODUCT}|you) (?:also |currently |natively )?(?:work|integrate|sync|connect|plug|support)s?(?: (?:with|to|into))? (?:a |an |the )?(.+)$`, 'i'),
  new RegExp(String.raw`^(?:is there|do you have|does it have|does ${PRODUCT} have) (?:an? |native |direct )?(.+?) (?:integration|connector|sync)$`, 'i'),
]
const LIST_SPLIT = /\s*(?:,|\/|&|\band\b|\bor\b|\bplus\b)\s*/i
const nameList = (phrase: string) => phrase.split(LIST_SPLIT).map(n => n.replace(/^(?:a|an|the)\s+/i, '').replace(/[)"'.]+$/, '').trim()).filter(Boolean)

const GREETING = /^(?:(?:hi|hey|hello|thanks|thank you|ok|okay|great|cheers|and|or|also|plus|but|then|so)\b[\s,!.-]*)+/i
const normalizeFragment = (fragment: string) => fragment.trim().replace(/[’‘]/g, "'").replace(GREETING, '').replace(/^(?:please|kindly|just)\s+|\s+(?:please|thanks|thank you)$|[?.!\s]+$/gi, '').replace(/\s+/g, ' ').trim()

type Resolved = { ok: true; topics: Topic[]; integrations: string[] } | { ok: false; reason: 'not_routine' | 'unknown_integration'; detail?: string }
// One fragment, one explicit outcome. It is routine when it is wholly one supported question, one supported request, an
// integration ask whose every name the facts list, or just a known integration's name (the rest of a list).
function resolveFragment(fragment: string, known: Set<string>): Resolved {
  const f = normalizeFragment(fragment)
  if (!f) return { ok: false, reason: 'not_routine' }
  if (known.has(f.toLowerCase().replace(/^(?:a|an|the)\s+/, ''))) return { ok: true, topics: [], integrations: [f] }
  for (const form of SUPPORTED_FORMS) if (form.re.test(f)) return { ok: true, topics: form.topics, integrations: [] }
  for (const form of REQUEST_FORMS) if (form.re.test(f)) return { ok: true, topics: form.topics, integrations: [] }
  for (const re of INTEGRATION_FORMS) {
    const m = re.exec(f)
    if (!m) continue
    const names = nameList(m[1])
    const unknown = names.filter(n => !known.has(n.toLowerCase()))
    if (!names.length) return { ok: false, reason: 'not_routine' }
    return unknown.length ? { ok: false, reason: 'unknown_integration', detail: unknown.join(', ') } : { ok: true, topics: [], integrations: names }
  }
  return { ok: false, reason: 'not_routine', detail: f }
}

const INTEGRATION_VERB = /\b(?:integrat\w*(?: with)?|work(?:s)? with|connect(?:s)? (?:to|with)|support(?:s)?|sync(?:s)? (?:to|with)|plug(?:s)? into)\s+/gi
const NOT_A_PRODUCT = new Set(['you', 'us', 'me', 'it', 'our', 'my', 'your', 'them', 'this', 'that', 'other', 'other tools', 'tools', 'email', 'people', 'other crms', 'other apps'])

// Every product named after any integration verb in the message, as a list: "Gmail and Salesforce", "HubSpot, Pipedrive
// or Zoho CRM", "Gmail/Outlook". Multi-word names stay whole. Each one is checked; none hides behind another.
function integrationsAsked(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(INTEGRATION_VERB)) {
    const rest = text.slice((m.index ?? 0) + m[0].length)
    const phrase = (/^[^?.!;\n]*/.exec(rest)?.[0] ?? '').split(/\b(?:too|as well|also|natively|out of the box|today|yet|now)\b|\s(?:so|because|if|when|or not)\s/i)[0]
    for (const name of nameList(phrase)) if (!NOT_A_PRODUCT.has(name.toLowerCase())) out.push(name)
  }
  return [...new Set(out)]
}

// The message as fragments: split at every sentence end, colon, semicolon, comma and conjunction or relative ("and",
// "or", "also", "plus", "but", "then", "as well as", "that", "which"), so a routine keyword in one part never vouches
// for the rest ("What is pricing and tell me where your team is based?" is two fragments; the second is not routine).
// It also splits before a request verb in the middle of a sentence ("Pricing please let me know where your team is
// based"), so an imperative request is always its own fragment.
const CLAUSE_JOIN = /\s*(?:[;:\n,]|[.?!](?:\s|$)|\s(?:and|or|also|plus|but|then|as well as|that|which)\s|\s(?=(?:tell (?:me|us)|let (?:me|us) know|share (?:your|the|with|me|us|our)|send (?:me|us|over)|show (?:me|us)|give (?:me|us)|(?:can|could|would|will) you|please|kindly|(?:explain|describe) (?:your|the|how|what|who|where|why|whether)|list (?:your|the|all)|confirm (?:that|you|your|the))\b))\s*/i
// Only a whole known phrase is harmless. Never discard arbitrary text after a greeting.
const PLEASANTRY = /^(?:(?:hi|hey|hello)(?: there)?|thanks|thank you|thx|cheers|great|ok|okay|sounds good|best|regards|sure|quick question|one question|a question|two questions|question|got it|noted|makes sense|interesting|sounds interesting|looks interesting|looks good)[!?.]*$|^(?:please|kindly|(?:can|could|would|will) you(?: please)?)[?!.]*$/i
function clauses(text: string): string[] {
  return text.split(CLAUSE_JOIN).map(c => c.replace(/^[\s,-]+|[\s,-]+$/g, '')).filter(c => c && !PLEASANTRY.test(c))
}

const usableText = (v: unknown) => typeof v === 'string' && v.trim().length >= 3
const httpsUrl = (v: unknown) => typeof v === 'string' && /^https:\/\/\S+$/.test(v)
// The approved facts this answer needs, each present and well-formed; anything missing means no automated answer.
function missingFacts(facts: ProductFacts, topics: Topic[], integrations: string[], meeting: boolean): string[] {
  const miss: string[] = []
  if (!usableText(facts.version)) miss.push('version')
  const need: [Topic | 'integration', keyof ProductFacts][] = [['pricing', 'pricing'], ['prerequisites', 'prerequisites'], ['how_to_start', 'howToStart'], ['limitations', 'limitations'], ['integration', 'limitations']]
  for (const [t, f] of need) if ((t === 'integration' ? integrations.length > 0 : topics.includes(t as Topic)) && !usableText(facts[f])) miss.push(f)
  if (!Array.isArray(facts.knownIntegrations)) miss.push('knownIntegrations')
  if (meeting ? !httpsUrl(facts.bookingUrl) : !httpsUrl(facts.signupUrl)) miss.push(meeting ? 'bookingUrl' : 'signupUrl')
  return [...new Set(miss)]
}

export function decide(inbound: Inbound, thread: ThreadState, facts: ProductFacts, policy: AnswerPolicy): Decision {
  const messageId = inbound.messageId
  if (thread.handledMessageIds.includes(messageId)) return { action: 'ignore', messageId }
  // An opt-out is a stop, not a send: it is honoured even in a thread the tenant has taken over.
  const cls = classifyReply(inbound.text)
  if (cls === 'opt_out') return { action: 'suppress', messageId }
  if (thread.takenOver) return { action: 'pause', messageId }
  if (!thread.authenticatedSender) return { action: 'escalate', messageId, reason: 'unauthenticated' }
  if (cls === 'negative' || cls === 'uncertain' || cls === 'auto') return { action: 'escalate', messageId, reason: 'negative', detail: cls }
  if (AUTHORITY.test(inbound.text)) return { action: 'escalate', messageId, reason: 'authority' }
  if (SENSITIVE.test(inbound.text)) return { action: 'escalate', messageId, reason: 'sensitive' }
  // (b) the subject must be the product or the buyer, never the seller's own account, business, people or finances
  const seller = sellerScope(inbound.text)
  if (seller) return { action: 'escalate', messageId, reason: 'seller_scope', detail: seller }
  // every integration asked must be one the facts list
  const known = new Set((Array.isArray(facts.knownIntegrations) ? facts.knownIntegrations : []).map(k => k.toLowerCase()))
  const unknown = integrationsAsked(inbound.text).filter(a => !known.has(a.toLowerCase()))
  if (unknown.length) return { action: 'escalate', messageId, reason: 'unknown_integration', detail: unknown.join(', ') }
  // (a) every fragment must be wholly one supported form; one fragment outside the forms escalates the whole message
  const cs = clauses(inbound.text)
  if (!cs.length) return { action: 'escalate', messageId, reason: 'not_routine' }
  const topicSet = new Set<Topic>(), asked: string[] = []
  for (const c of cs) {
    const res = resolveFragment(c, known)
    if (!res.ok) return { action: 'escalate', messageId, reason: res.reason, detail: res.detail }
    for (const t of res.topics) topicSet.add(t)
    for (const i of res.integrations) if (!asked.some(a => a.toLowerCase() === i.toLowerCase())) asked.push(i)
  }
  const topics = TOPIC_ORDER.filter(t => topicSet.has(t))
  if (thread.autoReplies >= policy.maxAutoReplies) return { action: 'escalate', messageId, reason: 'reply_limit' }
  const meeting = policy.cta === 'meeting' && !!facts.bookingUrl
  const miss = missingFacts(facts, topics, asked, meeting)
  if (miss.length) return { action: 'escalate', messageId, reason: 'facts_missing', detail: miss.join(', ') }
  const lines: string[] = []
  if (asked.length) lines.push(`${asked.join(', ')}: supported. ${facts.limitations}`)
  for (const t of topics) {
    if (t === 'pricing') lines.push(facts.pricing)
    else if (t === 'prerequisites') lines.push(facts.prerequisites)
    else if (t === 'how_to_start') lines.push(facts.howToStart)
    else if (t === 'limitations' && !asked.length) lines.push(facts.limitations)
  }
  lines.push(meeting ? `If it helps to talk it through, you can pick a time here: ${facts.bookingUrl}` : `You can start here: ${facts.signupUrl}`)
  return { action: 'reply', messageId, topics, body: [...new Set(lines)].join('\n\n'), factsVersion: facts.version }
}
