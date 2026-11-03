// The email conversation around routine buyer answers (#406). buyer-answers.ts decides ONE inbound message against a
// thread state the caller supplies; this module derives that state from the thread itself and the owner's policy, and
// turns each new inbound message into exactly one step:
//   ignored     a message id already handled, in the ledger or earlier in this same read (a retried webhook, a re-sync)
//   suppressed  an opt-out, in any language the reply classifier reads: never answered, whatever else holds the thread
//   paused      the tenant wrote in the thread from their own mailbox (a takeover): automation stops for the thread
//   exception   the owner must answer: anything buyer-answers escalates, an unapproved product record, or a routine
//               question asked while an earlier exception in the thread is still open (no answer around the owner)
//   approval    a routine answer, assembled from the approved record, that the policy says the owner approves first
//   send        a routine answer the policy lets go out on its own, with sender, consent and limits all in place
//   held        a routine answer the policy would send, but the sender, consent or a send limit is not in place yet
//   off         routine answers are off for this tenant: the inbox is the owner's, as before
// Exceptions (the owner decides what to say) and approvals (the answer is written; the owner only releases it) are
// separate outcomes so a routine approval is never counted as, or hidden among, unresolved exceptions (ownerQueue).
//
// Identity. A message is from the prospect only when its From address is exactly the address dazl wrote to AND the
// receiving mailbox's own authentication result says DMARC passed for that address's domain (senderAuthenticated).
// Anyone else in the thread (a colleague, a forwarder, a spoofed From) is escalated, never answered.
//
// Facts. The answer is built only from the product truth record (lib/product-truth.ts) as it is now, and only when the
// owner accepted exactly that version in their launch policy (claims.productTruthVersion). Never accepted: exception
// facts_unapproved. Changed since: exception facts_stale. The inbound text is never copied into the answer.
//
// Pure: no database, no network, no clock. The caller reads the thread and ledger, records each step, and sends only a
// `send` step through the normal guarded send path; nothing here sends.
import type { ProductTruth } from '../product-truth.ts'
import { productFactsFromTruth } from '../outreach/capability-claims.ts'
import { decide, type EscalateReason, type Topic } from './buyer-answers.ts'

export type AnswerMode = 'off' | 'approve' | 'auto'
export type AnswerCta = 'signup' | 'meeting'
// The owner's settings for routine answers, part of the launch policy the tenant accepts (launch-policy.ts answers).
export interface AnswerSettings {
  mode: AnswerMode
  cta: AnswerCta                                 // default call to action: self-serve signup or a meeting
  ctaByPlay: Record<string, AnswerCta>           // per-play override: the play the thread's lead came from decides
  maxAutoReplies: number                         // routine answers per thread, after which every message escalates
}
export const ANSWER_MODES: AnswerMode[] = ['off', 'approve', 'auto']
export const MAX_AUTO_REPLIES = 3

export interface ApprovedRecord {
  truth: ProductTruth                            // the record as it is now (productTruth(env))
  acceptedVersion: string | undefined            // the version the owner accepted (launch policy claims.productTruthVersion)
  signupUrl: string
  bookingUrl: string | null
}
export interface ThreadMessage {
  id: string                                     // the mailbox's message id
  from: string                                   // the From header as read
  text: string                                   // the new text of the message (reply-text.ts), not an excerpt
  authResults: string[]                          // Authentication-Results headers, top first, as the mailbox returned them
}
export type StepOutcome = 'ignored' | 'suppressed' | 'paused' | 'exception' | 'approval' | 'send' | 'held' | 'off'
export interface LedgerEntry {
  messageId: string
  outcome: StepOutcome
  sent?: boolean                                 // an answer for this message actually went out (send, or an approval released)
  // a 'held' entry is not final: the message is planned again on the next read
  resolved?: boolean                             // the owner closed this exception
}
export interface ConversationThread {
  prospect: string                               // the address dazl wrote to
  mailbox: string                                // the tenant's connected mailbox
  playId: string                                 // the play the lead came from
  messages: ThreadMessage[]                      // oldest first; may hold the same id twice
  dazlSent: string[]                             // ids of the messages dazl itself sent in this thread
  ledger: LedgerEntry[]                          // what was already recorded for this thread
}
export interface SendReadiness { sender: boolean; consent: boolean; withinLimits: boolean }

export type ExceptionReason = EscalateReason | 'facts_unapproved' | 'open_exception'
export type HeldReason = 'sender_not_configured' | 'no_consent' | 'send_limit'
interface Answer { topics: Topic[]; body: string; factsVersion: string; cta: AnswerCta }
export type Step =
  | { messageId: string; outcome: 'ignored' | 'suppressed' | 'paused' | 'off' }
  | { messageId: string; outcome: 'exception'; reason: ExceptionReason; detail?: string }
  | ({ messageId: string; outcome: 'approval' } & Answer)
  | ({ messageId: string; outcome: 'send' } & Answer)
  | ({ messageId: string; outcome: 'held'; why: HeldReason } & Answer)

const address = (v: string) => (/<([^>]+)>/.exec(v)?.[1] ?? v).trim().toLowerCase()

// The receiving mailbox stamps its own Authentication-Results (authserv-id mx.google.com for Gmail) above every header the
// message arrived with, so only the FIRST header carrying that id is the mailbox's verdict; one written further down (by
// the sender or any hop) proves nothing. DMARC pass with header.from equal to the sender's domain is the only proof
// accepted: an SPF or DKIM pass alone can be for another domain than the one in From.
const MAILBOX_AUTHSERV = /^\s*mx\.google\.com\s*;/i
export function senderAuthenticated(from: string, prospect: string, authResults: string[]): boolean {
  const f = address(from)
  if (!f.includes('@') || f !== address(prospect)) return false
  const verdict = authResults.find(h => MAILBOX_AUTHSERV.test(h))
  if (!verdict) return false
  const dmarc = /(?:^|;)\s*dmarc=([a-z]+)\b([^;]*)/i.exec(verdict)
  const headerFrom = dmarc ? /\bheader\.from=([^\s;()]+)/i.exec(dmarc[2])?.[1]?.toLowerCase() : undefined
  return !!dmarc && dmarc[1].toLowerCase() === 'pass' && headerFrom === f.split('@')[1]
}

export const ctaFor = (s: AnswerSettings, playId: string): AnswerCta => s.ctaByPlay[playId] ?? s.cta

// Every new inbound message in the thread, oldest first, gets exactly one step. Messages the tenant's mailbox sent are
// not inbound: dazl's own are skipped, any other one is a takeover.
export function conversationSteps(thread: ConversationThread, settings: AnswerSettings, record: ApprovedRecord, ready: SendReadiness): Step[] {
  const mailbox = address(thread.mailbox)
  const dazl = new Set(thread.dazlSent)
  const takenOver = thread.messages.some(m => address(m.from) === mailbox && !dazl.has(m.id))
  // a held answer was never sent and is planned again on the next read (it goes out once sender, consent and limits are
  // in place); every other recorded outcome is final for its message
  const handled = new Set(thread.ledger.filter(e => e.outcome !== 'held').map(e => e.messageId))
  let replies = thread.ledger.filter(e => e.sent === true).length
  let openException = thread.ledger.some(e => e.outcome === 'exception' && e.resolved !== true)
  const cta = ctaFor(settings, thread.playId)
  const facts = productFactsFromTruth(record.truth, { signupUrl: record.signupUrl, bookingUrl: record.bookingUrl })
  const steps: Step[] = []
  for (const m of thread.messages) {
    if (address(m.from) === mailbox) continue
    const messageId = m.id
    if (settings.mode === 'off') {
      steps.push({ messageId, outcome: handled.has(messageId) ? 'ignored' : 'off' })
      handled.add(messageId)
      continue
    }
    const d = decide(
      { messageId, text: m.text },
      { authenticatedSender: senderAuthenticated(m.from, thread.prospect, m.authResults), takenOver, handledMessageIds: [...handled], autoReplies: replies },
      facts,
      // never accepted: '' matches no record version, so decide stops at its version check (after opt-out and takeover)
      { cta, maxAutoReplies: Math.min(settings.maxAutoReplies, MAX_AUTO_REPLIES), acceptedFactsVersion: record.acceptedVersion ?? '' },
    )
    handled.add(messageId)
    if (d.action === 'ignore') { steps.push({ messageId, outcome: 'ignored' }); continue }
    if (d.action === 'suppress') { steps.push({ messageId, outcome: 'suppressed' }); continue }
    if (d.action === 'pause') { steps.push({ messageId, outcome: 'paused' }); continue }
    if (d.action === 'escalate') {
      const reason: ExceptionReason = d.reason === 'facts_stale' && record.acceptedVersion === undefined ? 'facts_unapproved' : d.reason
      steps.push({ messageId, outcome: 'exception', reason, ...(d.detail ? { detail: d.detail } : {}) })
      openException = true
      continue
    }
    if (openException) { steps.push({ messageId, outcome: 'exception', reason: 'open_exception' }); continue }
    const answer: Answer = { topics: d.topics, body: d.body, factsVersion: d.factsVersion, cta }
    if (settings.mode === 'approve') { steps.push({ messageId, outcome: 'approval', ...answer }); continue }
    const why: HeldReason | null = !ready.sender ? 'sender_not_configured' : !ready.consent ? 'no_consent' : !ready.withinLimits ? 'send_limit' : null
    if (why) { steps.push({ messageId, outcome: 'held', why, ...answer }); continue }
    steps.push({ messageId, outcome: 'send', ...answer })
    replies++ // reserved now: a second question in the same read counts against the per-thread limit
  }
  return steps
}

// What reaches the owner, kept apart: exceptions need the owner's own answer; approvals are written answers waiting
// only for release; held answers wait for the sender, consent or a limit, not for the owner's judgement.
export function ownerQueue(steps: Step[]): { exceptions: Extract<Step, { outcome: 'exception' }>[]; approvals: Extract<Step, { outcome: 'approval' }>[]; held: Extract<Step, { outcome: 'held' }>[] } {
  return {
    exceptions: steps.filter((s): s is Extract<Step, { outcome: 'exception' }> => s.outcome === 'exception'),
    approvals: steps.filter((s): s is Extract<Step, { outcome: 'approval' }> => s.outcome === 'approval'),
    held: steps.filter((s): s is Extract<Step, { outcome: 'held' }> => s.outcome === 'held'),
  }
}
