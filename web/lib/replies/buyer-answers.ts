// Routine buyer questions answered from approved product facts (#406). One inbound email in, one decision out:
//   suppress  an opt-out in any language the reply classifier knows: no answer, no pitch (even after a takeover)
//   pause     the tenant replied in the thread themselves: automation stops for that thread
//   ignore    a message already handled (a duplicate webhook or a retry): nothing is sent twice
//   escalate  anything outside authority or not known: discounts, guarantees, contracts, security reviews, an
//             integration or fact the record does not cover, an unauthenticated sender, or a question that is not routine
//   reply     pricing, prerequisites, how to start, limitations or booking, answered only from the versioned facts
// The answer is assembled from the facts alone. The inbound text picks which facts apply and is never copied into the
// reply, so it cannot change what dazl offers, reveal anything outside the facts, or point the answer at another
// account. Exceptions are reported as exceptions, separate from the routine approvals a tenant may still require.
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
export type EscalateReason = 'unauthenticated' | 'authority' | 'unknown_integration' | 'not_routine' | 'reply_limit' | 'negative' | 'sensitive' | 'facts_missing'
export type Decision =
  | { action: 'suppress'; messageId: string }
  | { action: 'pause'; messageId: string }
  | { action: 'ignore'; messageId: string }
  | { action: 'escalate'; messageId: string; reason: EscalateReason; detail?: string }
  | { action: 'reply'; messageId: string; topics: Topic[]; body: string; factsVersion: string }

const TOPICS: [Topic, RegExp][] = [
  ['pricing', /\b(?:price|pricing|cost|costs|how much|per month|subscription|billing|(?:pricing|paid|free|pro|which|what) plans?)\b|\$/i],
  ['prerequisites', /\b(?:need to have|prerequisites?|requirements?|what do i need|api key|own key|setup|set up|gmail account)\b/i],
  ['how_to_start', /\b(?:how (?:do|can) (?:i|we) (?:start|begin|try|sign up)|get started|getting started|sign ?up|trial|try it)\b/i],
  ['limitations', /\b(?:limits?|limitations?|is there a cap|how many (?:emails?|sends?|messages?|leads?|scans?|plays?|seats?|users?|mailboxes|inboxes|contacts))\b/i],
  ['booking', /\b(?:demo|call|meeting|meet|chat|walk ?through|book)\b/i],
]
// Outside an automated answer's authority, whatever else the message asks.
const AUTHORITY = /\d+\s?%\s?off\b|\b(?:discount|coupon|cheaper|lower price|deal on|free (?:month|months|year)|refund|guarantee[sd]?|promise|sla|contract|msa|dpa|terms|negotiat\w*|invoice terms|net ?30|security (?:questionnaire|review|assessment)|soc ?2|iso ?27001|pen ?test|gdpr agreement|legal)\b/i
// Questions no approved fact answers: where data lives and how it is handled, compliance, bespoke work or support. Always
// escalated, even beside a routine question.
const SENSITIVE = /\b(?:data (?:stored|storage|location|residency|retention|deletion|processing|privacy)|where (?:is|are|do you)\b.*\b(?:stored|store|hosted|host|kept|keep|located)|privacy|personal data|pii|hipaa|gdpr|ccpa|encrypt\w*|on[- ]?prem\w*|self[- ]?host\w*|custom (?:support|development|integration|feature|build)|dedicated (?:support|account manager)|white[- ]?label|resell\w*)\b/i
// A request for something account-specific of the seller's (their key, account, login, credentials, billing details or
// access) is never a routine question, however routine its words: "Please share your API key" is not "What API key do
// I need?".
const ACCOUNT_SPECIFIC = /\b(?:your|ur|the team'?s|dazl'?s)\s+(?:own\s+)?(?:(?:api|ai|openai|anthropic|license|licence)\s+)?(?:keys?|account|accounts|login|logins|password|passwords|credentials?|tokens?|secrets?|billing (?:details|info|information|address)|invoices?|card|cards|bank (?:details|account)|access)\b|\b(?:access|log ?in|sign ?in) (?:to|into) (?:your|the) (?:account|dashboard|workspace|admin)\b/i
// A request (share/send/give/show/tell/list/confirm/explain/describe) is routine only when what it asks for is one of the
// approved facts: pricing, plans, setup requirements, limits, how to start, or the demo or sign-up link.
const REQUEST_VERB = /^(?:(?:and|or|also|plus|but|then)\s+)?(?:(?:please|kindly)\s+)?(?:(?:can|could|would|will) you\s+(?:please\s+)?)?(?:share|send|give|show|tell|list|confirm|explain|describe|let (?:me|us) know)\b\s*(?:(?:me|us)\s+)?(?:(?:over|about)\s+)?/i
const REQUEST_OBJECT = /^(?:(?:your|the|a|an|some|more)\s+)?(?:(?:details|info|information) (?:on|about) (?:your |the )?)?(?:pricing|prices?|costs?|(?:pricing |paid |subscription )?plans?|subscription(?: options)?|setup(?: steps| requirements)?|requirements|prerequisites|limits|limitations|demo(?: link)?|booking link|sign ?up link|(?:link|steps) to (?:sign up|get started|start)|how (?:to|i|we) (?:get started|start|begin|sign up|set (?:it )?up)|what (?:i|we) need(?: to set up| to get started)?)\b/i
// What a question may mean to be answered automatically: the supported product questions, each matched against the
// WHOLE fragment (after greetings and "please"), with the product or the buyer as its subject. A question about the seller
// ("What is your Gmail account?", "How much do you pay per month?", "How many leads do you have?") matches none of them and
// escalates, whatever words it shares with a supported one.
const PRODUCT = String.raw`(?:it|this|dazl|the (?:product|tool|app|service)|your (?:product|tool|app|service))`
const SUPPORTED_QUESTIONS: RegExp[] = [
  // pricing
  new RegExp(String.raw`^(?:what(?:'s| is| are)|how much (?:is|are))(?: the| your)? (?:price|prices|pricing|cost|costs|paid plans?|pricing plans?|plans?|subscription)(?: (?:per|a) month| monthly)?(?: for ${PRODUCT})?$`, 'i'),
  new RegExp(String.raw`^how much(?: (?:is|does) ${PRODUCT}(?: cost)?)?(?: (?:per|a) month| monthly)?$`, 'i'),
  new RegExp(String.raw`^(?:what|how much) does ${PRODUCT} cost(?: (?:per|a) month| monthly)?$`, 'i'),
  /^(?:is there|do you have) a free (?:plan|tier|trial)$/i,
  /^(?:pricing|prices|price)$/i,
  // prerequisites
  /^what do (?:i|we) need(?: to (?:set (?:it )?up|get started|start|use it))?$/i,
  /^what (?:i|we) need(?: to (?:set (?:it )?up|get started|start))?$/i,
  /^what (?:api key|ai key|key|keys|account|accounts|mailbox) do (?:i|we) need$/i,
  /^do (?:i|we) need (?:my own |our own |an? |my |our )?(?:own )?(?:api key|ai key|key|gmail account|google account|gmail|account)$/i,
  /^what are the (?:requirements|prerequisites|setup requirements|setup steps)$/i,
  // how to start
  /^how (?:do|can) (?:i|we) (?:get started|start|begin|sign up|try it)$/i,
  // limitations
  /^how many (?:emails|sends|messages|leads|scans|plays|seats|users|mailboxes|inboxes|contacts) can (?:i|we|it|dazl) (?:send|find|run|use|add|connect|have)(?: (?:a|per) (?:day|week|month))?$/i,
  /^(?:what are|are there)(?: the| any)? (?:limits|limitations|caps)$/i,
  /^is there a (?:cap|limit)(?: on (?:sends|emails|leads|scans))?(?: (?:a|per) (?:day|week|month))?$/i,
  // booking
  /^can (?:i|we) (?:book|get|schedule) a (?:demo|call|meeting)(?: about (?:pricing|it|setup))?$/i,
  // integrations: the product works with a named tool
  new RegExp(String.raw`^(?:does|do|can|will) (?:${PRODUCT}|you) (?:also )?(?:work|integrate|sync|connect|plug|support)\b.*$`, 'i'),
]
const questionInScope = (fragment: string): boolean => {
  const f = fragment.trim().replace(/^(?:(?:hi|hey|hello|thanks|thank you|ok|okay|great|cheers|and|or|also|plus|but|then)\b[\s,!.-]*)+/i, '').replace(/^(?:please|kindly)\s+|\s+(?:please|thanks)$|[?.!\s]+$/gi, '').trim()
  return SUPPORTED_QUESTIONS.some(re => re.test(f))
}
const requestInScope = (fragment: string): boolean => {
  const m = REQUEST_VERB.exec(fragment.trim())
  // a request must ask for an approved fact; anything else must be one of the supported questions
  return m ? REQUEST_OBJECT.test(fragment.trim().slice(m[0].length)) : questionInScope(fragment)
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
    for (const raw of phrase.split(/\s*(?:,|\/|&|\band\b|\bor\b|\bplus\b)\s*/i)) {
      const name = raw.replace(/^(?:a|an|the)\s+/i, '').replace(/[)"'.]+$/, '').trim()
      if (name && !NOT_A_PRODUCT.has(name.toLowerCase())) out.push(name)
    }
  }
  return [...new Set(out)]
}

// The message as fragments: split at every sentence end, colon, semicolon, comma and conjunction or relative ("and",
// "or", "also", "plus", "but", "then", "as well as", "that", "which"), so a routine keyword in one part never vouches
// for the rest ("What is pricing and tell me where your team is based?" is two fragments; the second is not routine).
// It also splits before a request verb in the middle of a sentence ("Pricing please let me know where your team is
// based"), so an imperative request is always its own fragment.
const CLAUSE_JOIN = /\s*(?:[;:\n,]|[.?!](?:\s|$)|\s(?:and|or|also|plus|but|then|as well as|that|which)\s|\s(?=(?:tell (?:me|us)|let (?:me|us) know|share (?:your|the|with|me|us|our)|send (?:me|us|over)|show (?:me|us)|give (?:me|us)|(?:can|could|would|will) you|please|kindly|(?:explain|describe) (?:your|the|how|what|who|where|why|whether)|list (?:your|the|all)|confirm (?:that|you|your|the))\b))\s*/i
const PLEASANTRY = /^(?:hi|hey|hello|thanks|thank you|thx|cheers|great|ok|okay|sounds good|best|regards|sure)\b[\w\s,!-]{0,30}$|^(?:please|kindly|(?:can|could|would|will) you(?: please)?)[?!.]*$/i
function clauses(text: string): string[] {
  return text.split(CLAUSE_JOIN).map(c => c.replace(/^[\s,-]+|[\s,-]+$/g, '')).filter(c => c && !PLEASANTRY.test(c))
}

// The words a routine question or request may be made of: question words, auxiliaries, pronouns, politeness, the words of
// the routine topics and integration verbs, small numbers and units. Anything else is residue the facts do not cover.
const ROUTINE_WORDS = new Set((
  'what whats what\'s how much many is are was were do does did can could would will should may might it its this that ' +
  'there here i im i\'m we me us my our you your the a an to of for in on at with per by from about any some just ' +
  'please kindly thanks thank thx hi hey hello tell let know share send show give explain describe list confirm ' +
  'price prices pricing cost costs costing charge charges fee fees pay paid free pro plan plans subscription billing billed month monthly year yearly annual annually ' +
  'need needed have has required requirements requirement prerequisite prerequisites setup set up api key keys own account accounts gmail google anthropic openai ' +
  'start started starting begin get getting try trial sign signup sign-up sign-in signin ' +
  'limit limits limitation limitations cap caps emails email sends send messages message leads lead scans scan plays play seats seat users user mailboxes mailbox inboxes inbox contacts day daily week weekly ' +
  'demo call meeting meet chat walk walkthrough through book booking time ' +
  'integrate integrates integration integrations work works connect connects sync syncs support supports plug plugs into and or ' +
  'also too'
).split(/\s+/))
function residue(fragment: string, known: Set<string>): string[] {
  let t = fragment.toLowerCase()
  for (const k of [...known].sort((a, b) => b.length - a.length)) t = t.split(k).join(' ')
  return t.replace(/\$\s?\d[\d,.]*/g, ' ').split(/[^a-z0-9'$-]+/).filter(w => /[a-z0-9]/.test(w) && !ROUTINE_WORDS.has(w) && !/^\d+$/.test(w))
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
  if (SENSITIVE.test(inbound.text) || ACCOUNT_SPECIFIC.test(inbound.text)) return { action: 'escalate', messageId, reason: 'sensitive' }
  // every integration asked must be one the facts list
  const known = new Set((Array.isArray(facts.knownIntegrations) ? facts.knownIntegrations : []).map(k => k.toLowerCase()))
  const asked = integrationsAsked(inbound.text)
  const unknown = asked.filter(a => !known.has(a.toLowerCase()))
  if (unknown.length) return { action: 'escalate', messageId, reason: 'unknown_integration', detail: unknown.join(', ') }
  // every clause must be a routine question the facts answer; one unknown clause makes the whole message not routine
  const cs = clauses(inbound.text)
  // a fragment is routine only when it asks a routine topic or a known integration AND every word of it is routine
  // vocabulary (no residue), or it is itself just a known integration's name (the rest of a list). A topic keyword never
  // vouches for other words: "What is pricing please share your customer list" leaves "customer list" unexplained.
  const routine = (c: string) => {
    if (known.has(c.replace(/^(?:a|an|the)\s+|[?.!]+$/gi, '').trim().toLowerCase())) return true
    if (!TOPICS.some(([, re]) => re.test(c)) && !integrationsAsked(c).length) return false
    return residue(c, known).length === 0 && requestInScope(c)
  }
  if (!cs.length || !cs.every(routine)) return { action: 'escalate', messageId, reason: 'not_routine' }
  const topics = TOPICS.filter(([, re]) => re.test(inbound.text)).map(([t]) => t)
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
