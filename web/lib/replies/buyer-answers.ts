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
export type EscalateReason = 'unauthenticated' | 'authority' | 'unknown_integration' | 'not_routine' | 'reply_limit' | 'negative'
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
  ['limitations', /\b(?:limits?|limitations?|can it|does it|is there a cap|how many)\b/i],
  ['booking', /\b(?:demo|call|meeting|meet|chat|walk ?through|book)\b/i],
]
// Outside an automated answer's authority, whatever else the message asks.
const AUTHORITY = /\d+\s?%\s?off\b|\b(?:discount|coupon|cheaper|lower price|deal on|free (?:month|months|year)|refund|guarantee[sd]?|promise|sla|contract|msa|dpa|terms|negotiat\w*|invoice terms|net ?30|security (?:questionnaire|review|assessment)|soc ?2|iso ?27001|pen ?test|gdpr agreement|legal)\b/i
const INTEGRATION_ASK = /\b(?:integrat\w*(?: with)?|work(?:s)? with|connect(?:s)? (?:to|with)|support(?:s)?|sync(?:s)? (?:to|with))\s+(?:a |an |the )?([\w.]+)/gi
const NOT_A_PRODUCT = new Set(['you', 'us', 'me', 'it', 'our', 'my', 'your', 'them', 'this', 'that', 'other', 'other tools', 'tools', 'email', 'people'])

function integrationAsked(text: string): string | null {
  for (const m of text.matchAll(INTEGRATION_ASK)) {
    const name = m[1].replace(/\.+$/, '')
    if (!NOT_A_PRODUCT.has(name.toLowerCase())) return name
  }
  return null
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
  const asked = integrationAsked(inbound.text)
  if (asked && !facts.knownIntegrations.some(k => k.toLowerCase() === asked.toLowerCase())) return { action: 'escalate', messageId, reason: 'unknown_integration', detail: asked }
  const topics = TOPICS.filter(([, re]) => re.test(inbound.text)).map(([t]) => t)
  if (!topics.length && !asked) return { action: 'escalate', messageId, reason: 'not_routine' }
  if (thread.autoReplies >= policy.maxAutoReplies) return { action: 'escalate', messageId, reason: 'reply_limit' }
  const lines: string[] = []
  if (asked) lines.push(`${asked}: supported. ${facts.limitations}`)
  for (const t of topics) {
    if (t === 'pricing') lines.push(facts.pricing)
    else if (t === 'prerequisites') lines.push(facts.prerequisites)
    else if (t === 'how_to_start') lines.push(facts.howToStart)
    else if (t === 'limitations' && !asked) lines.push(facts.limitations)
  }
  const meeting = policy.cta === 'meeting' && facts.bookingUrl
  lines.push(meeting ? `If it helps to talk it through, you can pick a time here: ${facts.bookingUrl}` : `You can start here: ${facts.signupUrl}`)
  return { action: 'reply', messageId, topics, body: [...new Set(lines)].join('\n\n'), factsVersion: facts.version }
}
