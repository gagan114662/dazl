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
  ['pricing', /\b(?:price|pricing|cost|costs|how much|per month|plan|plans|subscription|billing)\b|\$/i],
  ['prerequisites', /\b(?:need to have|prerequisites?|requirements?|what do i need|api key|own key|setup|set up|gmail account)\b/i],
  ['how_to_start', /\b(?:how (?:do|can) (?:i|we) (?:start|begin|try|sign up)|get started|getting started|sign ?up|trial|try it)\b/i],
  ['limitations', /\b(?:limits?|limitations?|is there a cap|how many)\b/i],
  ['booking', /\b(?:demo|call|meeting|meet|chat|walk ?through|book)\b/i],
]
// Outside an automated answer's authority, whatever else the message asks.
const AUTHORITY = /\d+\s?%\s?off\b|\b(?:discount|coupon|cheaper|lower price|deal on|free (?:month|months|year)|refund|guarantee[sd]?|promise|sla|contract|msa|dpa|terms|negotiat\w*|invoice terms|net ?30|security (?:questionnaire|review|assessment)|soc ?2|iso ?27001|pen ?test|gdpr agreement|legal)\b/i
// Questions no approved fact answers: where data lives and how it is handled, compliance, bespoke work or support. Always
// escalated, even beside a routine question.
const SENSITIVE = /\b(?:data (?:stored|storage|location|residency|retention|deletion|processing|privacy)|where (?:is|are|do you)\b.*\b(?:stored|store|hosted|host|kept|keep|located)|privacy|personal data|pii|hipaa|gdpr|ccpa|encrypt\w*|on[- ]?prem\w*|self[- ]?host\w*|custom (?:support|development|integration|feature|build)|dedicated (?:support|account manager)|white[- ]?label|resell\w*)\b/i
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

// The message as clauses: sentences, and a sentence joining two questions ("What is pricing and where is data stored?").
const CLAUSE_JOIN = /\s*(?:[;\n]|[.?!](?:\s|$)|\s(?:and|also|plus|but)\s+(?=(?:what|where|when|who|why|how|which|is|are|can|could|do|does|did|will|would|should|may|might|has|have)\b))\s*/i
const PLEASANTRY = /^(?:hi|hey|hello|thanks|thank you|thx|cheers|great|ok|okay|sounds good|best|regards|sure)\b[\w\s,!-]{0,30}$/i
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
  // every integration asked must be one the facts list
  const known = new Set((Array.isArray(facts.knownIntegrations) ? facts.knownIntegrations : []).map(k => k.toLowerCase()))
  const asked = integrationsAsked(inbound.text)
  const unknown = asked.filter(a => !known.has(a.toLowerCase()))
  if (unknown.length) return { action: 'escalate', messageId, reason: 'unknown_integration', detail: unknown.join(', ') }
  // every clause must be a routine question the facts answer; one unknown clause makes the whole message not routine
  const cs = clauses(inbound.text)
  const routine = (c: string) => TOPICS.some(([, re]) => re.test(c)) || integrationsAsked(c).length > 0
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
