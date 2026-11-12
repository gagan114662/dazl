// The email conversation state machine for routine buyer questions (#803, part of #406). lib/replies/buyer-answers.ts
// decides ONE inbound message from the approved product facts; this module gives that decision a durable thread state
// and the one send it may lead to:
//   - authenticated thread identity: an inbound counts as the prospect only when its From is exactly the address the
//     thread's outreach went to AND the FIRST Authentication-Results header (the one Google's receiving MX prepends)
//     carries dmarc=pass for exactly that From domain (owner bar, #406 2026-11-04). Anything else escalates.
//   - user takeover: a message in the Gmail thread from the tenant's own mailbox that dazl did not send (its Message-ID is
//     not one of dazl's `dazl.*@<sender domain>` ids and its Gmail id is not a recorded dazl send) pauses automation for
//     that thread, now and for every later inbound in it (a recorded 'pause' keeps the thread paused).
//   - one decision per inbound, at most one send: the decision row is keyed by (tenant, inbound Gmail id) and is claimed
//     in one write BEFORE any send. A duplicate delivery, a retry or a concurrent sync of the same message finds the row
//     and does nothing (ignore). A reply claim is 'sending'; it becomes 'sent' only on a confirmed Gmail handoff,
//     'uncertain' on an unknown outcome (tenant sending paused, never retried) or 'held' when a guard refuses the send.
//   - per-thread budget: answers already sent, in flight or uncertain in the thread count against the policy's maximum.
// Nothing of the inbound body is stored here: the decision keeps its action, reason code, topics and facts version
// only (owner decision on #406, 2026-11-04: full reply bodies are never stored). The answer text is rebuilt from the
// facts version, so the row needs no copy of it either.
//
// THE SWITCH. Automated answers are OFF for every tenant. They run only when ALL of these hold:
//   1. the tenant's answer policy (autopilot_settings.answers_*) is enabled, through setAnswerPolicy, which requires the
//      exact product truth version the owner accepted the facts at (a changed record answers nothing: facts_stale);
//   2. autopilot is available on the deployment (AUTOPILOT_ENABLED=1, no AUTOPILOT_KILL) and enabled, not paused, for
//      the tenant; there is no uncertain send; the shared daily send cap has room;
//   3. reply reading runs (read consent + read scope), since this is driven from syncReplies.
import type Database from 'better-sqlite3'
import { decide, type AnswerPolicy, type Decision, type ProductFacts, type ThreadState, type Topic } from './buyer-answers.ts'
import type { GPart } from '../outreach/reply-text.ts'
import type { ReplyClass } from '../outreach/replies.ts'
import { norm } from '../outreach/store.ts'
import { accountSendCount, ACCOUNT_SEND_CAP, anyUncertainSend, tableExists } from '../outreach/send-budget.ts'
import { auditAt, autopilotAvailable, DEFAULT_AUTO_REPLIES, MAX_AUTO_REPLIES_LIMIT, migrateAnswerPolicyColumns, pause } from '../outreach/autopilot.ts'
import { recheckSendAuthority } from '../outreach/send-authority.ts'
import { composeBody, getSettings, recipientAllowed, unsubToken, type Deps } from '../outreach/service.ts'
import { buildMime, toBase64Url } from '../gmail/mime.ts'
import { confirmedSendResult, getAccessTokenBound, gmailSend, GmailError, GmailSendError, type OAuthDeps } from '../gmail/oauth.ts'
import { getMasterKey } from '../secrets.ts'
import { productTruth, PRODUCT_TRUTH_VERSION_RE } from '../product-truth.ts'
import { productFactsFromTruth } from '../outreach/capability-claims.ts'

export function migrateBuyerAnswers(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS buyer_answer_decisions (
      tenant_id     TEXT NOT NULL,
      gmail_id      TEXT NOT NULL CHECK (length(gmail_id) <= 128),
      thread_id     TEXT NOT NULL CHECK (length(thread_id) <= 128),
      action        TEXT NOT NULL CHECK (action IN ('reply','escalate','pause','suppress')),
      reason        TEXT CHECK (reason IS NULL OR length(reason) <= 40),
      topics        TEXT CHECK (topics IS NULL OR length(topics) <= 120),
      facts_version TEXT CHECK (facts_version IS NULL OR length(facts_version) <= 40),
      status        TEXT NOT NULL CHECK (status IN ('recorded','sending','sent','uncertain','held')),
      sent_gmail_id TEXT CHECK (sent_gmail_id IS NULL OR length(sent_gmail_id) <= 128),
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      CHECK ((action = 'reply') = (status <> 'recorded')),
      CHECK ((sent_gmail_id IS NOT NULL) = (status = 'sent')),
      PRIMARY KEY (tenant_id, gmail_id)
    );
    CREATE INDEX IF NOT EXISTS buyer_answer_decisions_thread ON buyer_answer_decisions (tenant_id, thread_id);
  `)
  if (!tableExists(db, 'autopilot_settings')) return // migrateAutopilot adds the policy columns when it runs later
  migrateAnswerPolicyColumns(db)
}

export { DEFAULT_AUTO_REPLIES, MAX_AUTO_REPLIES_LIMIT }
export interface StoredAnswerPolicy { enabled: boolean; cta: 'signup' | 'meeting'; maxAutoReplies: number; acceptedFactsVersion: string | null }

export function getAnswerPolicy(db: Database.Database, tenantId: string): StoredAnswerPolicy | null {
  try {
    const r = db.prepare('SELECT answers_enabled, answers_cta, answers_max, answers_facts_version FROM autopilot_settings WHERE tenant_id = ?').get(tenantId) as { answers_enabled: number; answers_cta: string; answers_max: number; answers_facts_version: string | null } | undefined
    if (!r) return null
    return { enabled: Number(r.answers_enabled) === 1, cta: r.answers_cta === 'meeting' ? 'meeting' : 'signup', maxAutoReplies: Number(r.answers_max), acceptedFactsVersion: r.answers_facts_version }
  } catch { return null } // schema not migrated or unreadable: no policy, so nothing is answered
}

export type PolicyProblem = 'no_automation_settings' | 'cta_invalid' | 'max_invalid' | 'facts_version_invalid' | 'facts_version_required'
// The tenant turns automated answers on (or off) here. On needs the product truth version the tenant accepted the facts
// at: a version-less "yes" would follow every later change of the record.
export function setAnswerPolicy(db: Database.Database, tenantId: string, p: { enabled: unknown; cta?: unknown; maxAutoReplies?: unknown; acceptedFactsVersion?: unknown }): { ok: boolean; problems: PolicyProblem[] } {
  const problems: PolicyProblem[] = []
  const enabled = p.enabled === true
  const cta = p.cta === undefined ? 'signup' : p.cta
  const max = p.maxAutoReplies === undefined ? DEFAULT_AUTO_REPLIES : p.maxAutoReplies
  const version = p.acceptedFactsVersion === undefined || p.acceptedFactsVersion === null ? null : p.acceptedFactsVersion
  if (cta !== 'signup' && cta !== 'meeting') problems.push('cta_invalid')
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > MAX_AUTO_REPLIES_LIMIT) problems.push('max_invalid')
  if (version !== null && (typeof version !== 'string' || !PRODUCT_TRUTH_VERSION_RE.test(version))) problems.push('facts_version_invalid')
  if (enabled && version === null) problems.push('facts_version_required')
  if (problems.length) return { ok: false, problems }
  const r = db.prepare('UPDATE autopilot_settings SET answers_enabled = ?, answers_cta = ?, answers_max = ?, answers_facts_version = ? WHERE tenant_id = ?').run(enabled ? 1 : 0, cta, max, version, tenantId)
  if (r.changes !== 1) return { ok: false, problems: ['no_automation_settings'] }
  auditAt(db, tenantId, enabled ? 'buyer_answers_on' : 'buyer_answers_off', enabled ? `facts ${version}, ${cta}, max ${max}` : undefined)
  return { ok: true, problems: [] }
}

// ---------- thread identity ----------
const header = (p: GPart | undefined, name: string) => p?.headers?.find(h => h.name.toLowerCase() === name)?.value
const TRUSTED_AUTHSERV_IDS: readonly string[] = ['mx.google.com', 'google.com']
// dmarc=pass for exactly the From domain, in the first Authentication-Results only (deeper ones travelled with the
// message and can be written by anyone).
export function inboundAuthenticated(payload: GPart | undefined, from: string, prospect: string): boolean {
  const sender = norm(from), expected = norm(prospect)
  if (!sender || sender !== expected) return false
  const domain = sender.split('@')[1]
  if (!domain) return false
  const first = header(payload, 'authentication-results') ?? ''
  if (!first.trim()) return false
  if (!TRUSTED_AUTHSERV_IDS.includes(first.split(';', 1)[0].trim().toLowerCase())) return false
  for (const m of first.matchAll(/(?:^|;)\s*dmarc=([a-z]+)\b([^;]*)/gi)) {
    if (m[1].toLowerCase() !== 'pass') continue
    const hf = /\bheader\.from=([^\s;]+)/i.exec(m[2])?.[1]?.toLowerCase().replace(/^[.@]+/, '')
    if (hf === domain) return true
  }
  return false
}

// A message from the tenant's own mailbox is dazl's when its Message-ID is one of dazl's ids on the sender domain, or its
// Gmail id is a recorded dazl send. Anything else from that mailbox is the tenant writing in the thread themselves.
export function dazlAuthored(db: Database.Database, tenantId: string, g: { id: string; payload?: GPart }, senderDomain: string): boolean {
  const mid = (header(g.payload, 'message-id') ?? '').trim().toLowerCase()
  const m = /^<dazl\.[a-z0-9.]+@([^\s<>]+)>$/.exec(mid)
  if (m && m[1] === senderDomain.toLowerCase()) return true
  const sent: [string, string][] = [['outreach_messages', 'gmail_id'], ['followup_messages', 'gmail_id'], ['sequence_steps', 'gmail_id'], ['reopen_messages', 'gmail_id'], ['buyer_answer_decisions', 'sent_gmail_id']]
  for (const [table, col] of sent) if (tableExists(db, table) && db.prepare(`SELECT 1 FROM ${table} WHERE tenant_id = ? AND ${col} = ?`).get(tenantId, g.id)) return true
  return false
}

const threadPaused = (db: Database.Database, tenantId: string, threadId: string) =>
  !!db.prepare("SELECT 1 FROM buyer_answer_decisions WHERE tenant_id = ? AND thread_id = ? AND action = 'pause'").get(tenantId, threadId)
const repliesInThread = (db: Database.Database, tenantId: string, threadId: string) =>
  (db.prepare("SELECT count(*) AS n FROM buyer_answer_decisions WHERE tenant_id = ? AND thread_id = ? AND status IN ('sending','sent','uncertain')").get(tenantId, threadId) as { n: number }).n

// ---------- one inbound ----------
export interface AnswerInput {
  threadId: string
  prospect: string            // the address the thread's outreach went to
  leadId: string
  outreachMessageId: string   // the thread's original send (its id names every dazl message in the thread)
  rootMessageId: string       // Message-ID of the original send, without brackets
  subject: string
  tenantWroteInThread: boolean
  cls: ReplyClass             // the reply classifier's verdict on the whole message (both bodies, auto-reply headers)
  inbound: { gmailId: string; from: string; text: string; payload?: GPart }
}
export interface AnswerDeps extends Deps { now?: number; flags?: Record<string, string | undefined>; facts?: ProductFacts }
export type AnswerOutcome =
  | { outcome: 'off' }
  | { outcome: 'ignore' }
  | { outcome: 'recorded'; action: 'escalate' | 'pause' | 'suppress'; reason?: string }
  | { outcome: 'sent'; topics: Topic[]; gmailId: string }
  | { outcome: 'held'; reason: string }
  | { outcome: 'uncertain' }

const GMAIL_ID = /^[A-Za-z0-9_-]{1,128}$/
const MESSAGE_ID = /^<([^<>\s]{1,250})>$/

export async function answerInbound(db: Database.Database, tenantId: string, i: AnswerInput, d: AnswerDeps = {}): Promise<AnswerOutcome> {
  const now = d.now ?? Math.floor(Date.now() / 1000)
  const flags = d.flags ?? (d.env as Record<string, string | undefined> | undefined) ?? process.env
  const policy = getAnswerPolicy(db, tenantId)
  if (!policy?.enabled) return { outcome: 'off' }
  if (!tableExists(db, 'buyer_answer_decisions')) return { outcome: 'off' }
  const messageId = i.inbound.gmailId
  if (typeof messageId !== 'string' || !GMAIL_ID.test(messageId) || typeof i.threadId !== 'string' || !i.threadId || i.threadId.length > 128) return { outcome: 'off' }
  if (db.prepare('SELECT 1 FROM buyer_answer_decisions WHERE tenant_id = ? AND gmail_id = ?').get(tenantId, messageId)) return { outcome: 'ignore' }

  const settings = getSettings(db, tenantId)
  const base = (d.baseUrl ?? d.env?.PUBLIC_BASE_URL ?? process.env.PUBLIC_BASE_URL ?? 'https://dazl.ai').replace(/\/$/, '')
  let facts: ProductFacts
  try { facts = d.facts ?? productFactsFromTruth(productTruth(flags), { signupUrl: `${base}/sign-up`, bookingUrl: settings?.booking_url || null }) } catch { facts = { version: '', pricing: '', prerequisites: '', howToStart: '', limitations: '', signupUrl: '', bookingUrl: null, knownIntegrations: [] } }
  const thread: ThreadState = {
    authenticatedSender: inboundAuthenticated(i.inbound.payload, i.inbound.from, i.prospect),
    takenOver: i.tenantWroteInThread || threadPaused(db, tenantId, i.threadId),
    handledMessageIds: [],
    autoReplies: repliesInThread(db, tenantId, i.threadId),
  }
  const answerPolicy: AnswerPolicy = { cta: policy.cta, maxAutoReplies: policy.maxAutoReplies, acceptedFactsVersion: policy.acceptedFactsVersion ?? '' }
  // The whole-message verdict is the stronger one (it read both bodies and the auto-reply headers): an opt-out stops,
  // anything unclear or negative goes to the owner; only otherwise does the text pick the routine answer.
  let decision: Decision
  const text = typeof i.inbound.text === 'string' ? i.inbound.text : ''
  if (i.cls === 'opt_out') decision = { action: 'suppress', messageId }
  else if (i.cls === 'negative' || i.cls === 'uncertain' || i.cls === 'auto') decision = thread.takenOver ? { action: 'pause', messageId } : { action: 'escalate', messageId, reason: 'negative', detail: i.cls }
  else decision = decide({ messageId, text }, thread, facts, answerPolicy)
  if (decision.action === 'ignore') return { outcome: 'ignore' }

  // Claim the decision before anything else happens: one row per inbound, so a duplicate never acts twice.
  const reply = decision.action === 'reply' ? decision : null
  const claimed = db.prepare(`INSERT INTO buyer_answer_decisions (tenant_id, gmail_id, thread_id, action, reason, topics, facts_version, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tenant_id, gmail_id) DO NOTHING`).run(tenantId, messageId, i.threadId, decision.action, decision.action === 'escalate' ? decision.reason : null,
    reply ? reply.topics.join(',') : null, reply ? reply.factsVersion.slice(0, 40) : null, reply ? 'sending' : 'recorded', now, now).changes
  if (claimed !== 1) return { outcome: 'ignore' }
  if (!reply) {
    const why = decision.action === 'escalate' ? decision.reason : undefined
    auditAt(db, tenantId, `buyer_answer_${decision.action === 'escalate' ? 'escalated' : decision.action === 'pause' ? 'paused' : 'suppressed'}`, why, i.leadId, i.outreachMessageId, now)
    return { outcome: 'recorded', action: decision.action as 'escalate' | 'pause' | 'suppress', reason: why }
  }

  const hold = (reason: string): AnswerOutcome => {
    db.prepare("UPDATE buyer_answer_decisions SET status = 'held', reason = ?, updated_at = ? WHERE tenant_id = ? AND gmail_id = ? AND status = 'sending'").run(reason.slice(0, 40), now, tenantId, messageId)
    auditAt(db, tenantId, 'buyer_answer_held', reason, i.leadId, i.outreachMessageId, now)
    return { outcome: 'held', reason }
  }
  // Every automation guard, after the claim (the claim itself counts against the shared daily cap).
  if (!autopilotAvailable(flags)) return hold('not_available')
  const st = db.prepare('SELECT enabled, paused, daily_cap FROM autopilot_settings WHERE tenant_id = ?').get(tenantId) as { enabled: number; paused: number; daily_cap: number } | undefined
  if (!st || Number(st.enabled) !== 1) return hold('autopilot_off')
  if (Number(st.paused) === 1) return hold('paused')
  if (anyUncertainSend(db, tenantId)) return hold('uncertain_send')
  if (!settings) return hold('sender_settings_missing')
  if (!recipientAllowed(db, tenantId, i.prospect)) return hold('recipient_not_allowed')
  if (accountSendCount(db, tenantId, now) > Math.min(ACCOUNT_SEND_CAP, Number(st.daily_cap))) return hold('daily_cap')
  const acct = db.prepare('SELECT email, status FROM gmail_accounts WHERE tenant_id = ?').get(tenantId) as { email: string; status: string } | undefined
  if (!acct || acct.status !== 'active') return hold('gmail_not_connected')

  let token: string, tokenGen: string
  try { const b = await getAccessTokenBound(db, tenantId, d as OAuthDeps); token = b.token; tokenGen = b.refreshCt } catch { return hold('gmail_unavailable') }
  const domain = acct.email.split('@')[1] ?? ''
  const inReplyTo = MESSAGE_ID.exec((header(i.inbound.payload, 'message-id') ?? '').trim())?.[1] ?? i.rootMessageId
  const unsubUrl = `${base}/api/unsubscribe?t=${unsubToken(i.outreachMessageId, d.master ?? getMasterKey())}`
  let raw: string
  try {
    raw = toBase64Url(buildMime({ fromName: settings.sender_name, fromEmail: acct.email, to: i.prospect, subject: i.subject.startsWith('Re:') ? i.subject : `Re: ${i.subject}`,
      body: composeBody(reply.body, settings, unsubUrl), messageId: `dazl.a${thread.autoReplies}.${i.outreachMessageId}@${domain}`, unsubscribeUrl: unsubUrl, date: new Date(now * 1000), inReplyTo }))
  } catch { return hold('message_invalid') }
  // The shared authority recheck after the token await, right before the handoff: identity, connection, suppression and
  // the automation switch as they are NOW. A takeover recorded meanwhile also stops it.
  const why = recheckSendAuthority(db, tenantId, { to: i.prospect, sender: acct.email, now: d.now ?? Math.floor(Date.now() / 1000), autopilot: 'running', expectRefreshCt: tokenGen })
  if (why) return hold(why)
  if (threadPaused(db, tenantId, i.threadId)) return hold('taken_over')
  try {
    const r = confirmedSendResult(await (d.sendFn ?? gmailSend)(token, raw, d.fetchImpl, i.threadId))
    db.prepare("UPDATE buyer_answer_decisions SET status = 'sent', sent_gmail_id = ?, updated_at = ? WHERE tenant_id = ? AND gmail_id = ?").run(r.id, now, tenantId, messageId)
    auditAt(db, tenantId, 'buyer_answer_sent', `${reply.topics.join(',') || 'integration'} (facts ${reply.factsVersion})`, i.leadId, i.outreachMessageId, now)
    return { outcome: 'sent', topics: reply.topics, gmailId: r.id }
  } catch (e) {
    // A definite refusal (an HTTP error status, a configuration refusal) sent nothing: held for the owner, never retried.
    if (e instanceof GmailSendError || e instanceof GmailError) return hold(e instanceof GmailSendError ? `gmail_${e.status}` : 'gmail_refused')
    // Unknown outcome: the mail may have gone. Kept as uncertain (it counts in the thread's answers and the daily cap) and
    // never retried: the decision row stops any second answer to this message. The tenant's automation pauses
    // (uncertain_send) until they resume it from the Autopilot page. It is deliberately not an account-wide
    // anyUncertainSend block: that state has no resolve path for an answer, and nothing here can send this answer twice.
    db.prepare("UPDATE buyer_answer_decisions SET status = 'uncertain', updated_at = ? WHERE tenant_id = ? AND gmail_id = ?").run(now, tenantId, messageId)
    auditAt(db, tenantId, 'uncertain', 'buyer answer outcome unknown', i.leadId, i.outreachMessageId, now)
    pause(db, tenantId, 'uncertain_send')
    return { outcome: 'uncertain' }
  }
}

// What the inbox can show for a thread: each decision, oldest first. Codes only, no message text.
export function threadDecisions(db: Database.Database, tenantId: string, threadId: string): { gmail_id: string; action: string; reason: string | null; topics: string | null; status: string; created_at: number }[] {
  if (!tableExists(db, 'buyer_answer_decisions')) return []
  return db.prepare('SELECT gmail_id, action, reason, topics, status, created_at FROM buyer_answer_decisions WHERE tenant_id = ? AND thread_id = ? ORDER BY created_at, gmail_id').all(tenantId, threadId) as { gmail_id: string; action: string; reason: string | null; topics: string | null; status: string; created_at: number }[]
}
