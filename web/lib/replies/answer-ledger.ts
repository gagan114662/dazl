// Routine buyer answers, wired (#406): the answer-decision ledger, its planning during the reply sync, and the guarded
// send. buyer-conversation.ts decides; this module records every decision and sends only what may go out.
//
// The ledger (buyer_answers) holds exactly one row per inbound message the planner has seen: the outcome
// (suppressed / paused / exception / approval / send / held / off), why, the facts version an answer was written from,
// the answer itself (built from the accepted product truth record only, never from the inbound text), and the mailbox's
// own authentication verdict for the message. The row is the send-once guarantee: its key is (tenant, inbound message),
// a decision other than 'held' is final, and an answer leaves only through one compare-and-set claim (ready -> sending).
// A duplicate webhook, a retried sync or two ticks at once find the row and do nothing.
//
// What the planner reads: the full new text of each inbound message as the mailbox returned it (reply-text.ts
// messageText, not the 200-character excerpt the inbox keeps) and its Authentication-Results headers. Neither is
// stored: the reading consent (read-consent.ts) promises no full reply bodies. The ledger keeps only the verdict line
// the identity check relied on (bounded), so an owner can see why a sender counted as authenticated or not.
//
// What the sender checks, again, at the moment of sending: autopilot on, not paused, current consent, the operator
// switch; the tenant's accepted launch policy still launched (calibrated) from the same mailbox, answers still on in a
// mode that allows this row, the product truth record still the version the owner accepted and the answer was written
// from; the recipient not suppressed, not a personal address, the lead not held; the thread not stopped (opt-out, no,
// bounce, review); no send of any kind in an unknown state; the shared 24-hour account budget. Anything ambiguous after
// the request left marks the row 'uncertain' and pauses autopilot, exactly like every other send path.
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { buildMime, toBase64Url } from '../gmail/mime.ts'
import { confirmedSendResult, getAccessToken, gmailSend, gmailStatus, type OAuthDeps } from '../gmail/oauth.ts'
import { productTruth } from '../product-truth.ts'
import { auditAt, autopilotAvailable, getState, pause } from '../outreach/autopilot.ts'
import { calibratedStop, launchGate, readLaunchPolicy, type LaunchGate } from '../outreach/launch-policy.ts'
import { accountSendCount, ACCOUNT_SEND_CAP, anyUncertainSend, tableExists } from '../outreach/send-budget.ts'
import { composeBody, getSettings, isSuppressed, leadHeld, recipientAllowed, unsubToken, type Deps } from '../outreach/service.ts'
import { norm, replySafetyStale } from '../outreach/store.ts'
import { messageText, type GPart } from '../outreach/reply-text.ts'
import { getMasterKey } from '../secrets.ts'
import { StaleLeaseWrite } from '../shared/lease.ts'
import { conversationSteps, mailboxVerdict, senderAuthenticated, type AnswerSettings, type LedgerEntry, type SendReadiness, type Step, type ThreadMessage } from './buyer-conversation.ts'

export const OUTCOMES = ['suppressed', 'paused', 'exception', 'approval', 'send', 'held', 'off'] as const
// recorded: final (or, for 'held' and an unreleased 'approval', waiting); ready: may be sent now; sending: claimed, the
// request is in flight; sent: delivered (Gmail returned an id); uncertain: the outcome is unknown (never retried);
// cancelled: a ready answer the send-time checks refused for good (the thread stopped, the recipient suppressed, ...).
export const STATUSES = ['recorded', 'ready', 'sending', 'sent', 'uncertain', 'cancelled'] as const
const MAX_BODY = 4000, MAX_DETAIL = 200, MAX_VERDICT = 300

export function migrateBuyerAnswers(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS buyer_answers (
    tenant_id TEXT NOT NULL,
    message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 200),
    thread_id TEXT NOT NULL,
    lead_id TEXT,
    outreach_message_id TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('suppressed','paused','exception','approval','send','held','off')),
    reason TEXT CHECK (reason IS NULL OR length(reason) <= 40),
    detail TEXT CHECK (detail IS NULL OR length(detail) <= 200),
    topics TEXT CHECK (topics IS NULL OR length(topics) <= 200),
    facts_version TEXT CHECK (facts_version IS NULL OR length(facts_version) <= 40),
    cta TEXT CHECK (cta IS NULL OR cta IN ('signup','meeting')),
    body TEXT CHECK (body IS NULL OR length(body) <= 4000),
    auth TEXT NOT NULL CHECK (auth IN ('pass','fail')),
    auth_verdict TEXT CHECK (auth_verdict IS NULL OR length(auth_verdict) <= 300),
    status TEXT NOT NULL CHECK (status IN ('recorded','ready','sending','sent','uncertain','cancelled')),
    sent_gmail_id TEXT,
    claimed_at INTEGER,
    released_at INTEGER,
    resolved_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, message_id)
  );
  CREATE INDEX IF NOT EXISTS buyer_answers_thread ON buyer_answers (tenant_id, thread_id);
  CREATE INDEX IF NOT EXISTS buyer_answers_status ON buyer_answers (tenant_id, status);`)
}

// ---------- planning (called by the reply sync for each outreach thread it read) ----------
interface GHeader { name: string; value: string }
export interface GThreadMsg { id: string; payload?: GPart & { headers?: GHeader[] } }
export interface ThreadContext { threadId: string; leadId: string; outreachId: string; prospect: string; mailbox: string; messages: GThreadMsg[] }
export interface PlanDeps { flags?: Record<string, string | undefined>; env?: Record<string, string | undefined>; baseUrl?: string; now: number }

// Messages the sync logged as something other than a person's words are not questions: delivery notices and
// auto-replies are left alone (no answer, no exception).
const NOT_A_MESSAGE = new Set(['bounce', 'soft_bounce', 'bounce_review', 'bounce_unmatched', 'auto'])
// A header list that is not a list, or an entry without a string name and value, is no header (malformed mail reads as
// unauthenticated and unreadable, never as a pass).
const headerValues = (g: GThreadMsg, name: string): string[] => {
  const hs: unknown = g?.payload?.headers
  return Array.isArray(hs) ? hs.filter((h): h is GHeader => typeof h?.name === 'string' && h.name.toLowerCase() === name && typeof h.value === 'string').map(h => h.value) : []
}
const clip = (v: string | null | undefined, n: number) => (typeof v === 'string' ? v.slice(0, n) : null)

// The answer settings in force: only from a launch policy the tenant accepted, at the current version, with no problem,
// and only for threads whose lead came from a play in that policy's audience. Anything else: no answers (null).
function answerSettingsFor(db: Database.Database, tenantId: string, playId: string): { settings: AnswerSettings; acceptedVersion: string | undefined } | null {
  const s = readLaunchPolicy(db, tenantId)
  const a = s?.policy.answers
  if (!s || !a || a.mode === 'off') return null
  if (!s.policy.audience.playIds.includes(playId)) return null
  return { settings: a, acceptedVersion: s.policy.claims.productTruthVersion }
}

// Whether an answer could go out now (the planner's SendReadiness). The sender is the launch's own mailbox, launched by
// a passing preflight; consent is autopilot's grant plus this recipient not being suppressed or a personal address;
// limits are the shared 24-hour account budget, the launch's cap and no send of any kind in an unknown state.
function readiness(db: Database.Database, tenantId: string, prospect: string, gate: LaunchGate, flags: Record<string, string | undefined>, now: number): SendReadiness {
  const st = getState(db, tenantId)
  const sender = gate.calibrated && !!getSettings(db, tenantId)
  const consent = autopilotAvailable(flags) && st.enabled && !st.paused && st.consent_current && !isSuppressed(db, tenantId, prospect) && recipientAllowed(db, tenantId, prospect)
  const cap = Math.min(ACCOUNT_SEND_CAP, st.daily_cap, gate.calibrated ? gate.cap : 0)
  // the launch's own stops (any reply when the policy pauses on replies, the bounce rate) hold answers like every send
  const stopped = gate.calibrated ? calibratedStop(db, tenantId, gate) !== null : true
  const withinLimits = !stopped && !anyUncertainSend(db, tenantId) && !answerInFlight(db, tenantId) && accountSendCount(db, tenantId, now) < cap
  return { sender, consent, withinLimits }
}
const answerInFlight = (db: Database.Database, tenantId: string) => !!db.prepare("SELECT 1 FROM buyer_answers WHERE tenant_id = ? AND status IN ('sending','uncertain')").get(tenantId)

// Ids of the messages dazl itself sent in this thread: the first touch, follow-ups, sequence steps and earlier answers.
// Any other message from the tenant's mailbox is the tenant writing by hand: a takeover.
function dazlSentIds(db: Database.Database, tenantId: string, threadId: string, outreachId: string): string[] {
  const ids = new Set<string>()
  const add = (rows: { g: string | null }[]) => rows.forEach(r => { if (r.g) ids.add(r.g) })
  add(db.prepare('SELECT gmail_id AS g FROM outreach_messages WHERE tenant_id = ? AND (id = ? OR thread_id = ?)').all(tenantId, outreachId, threadId) as { g: string | null }[])
  if (tableExists(db, 'followup_messages')) add(db.prepare('SELECT gmail_id AS g FROM followup_messages WHERE tenant_id = ? AND thread_id = ?').all(tenantId, threadId) as { g: string | null }[])
  if (tableExists(db, 'sequence_steps') && tableExists(db, 'sequences')) add(db.prepare('SELECT s.gmail_id AS g FROM sequence_steps s JOIN sequences q ON q.id = s.sequence_id AND q.tenant_id = s.tenant_id WHERE s.tenant_id = ? AND q.message_id = ?').all(tenantId, outreachId) as { g: string | null }[])
  add(db.prepare('SELECT sent_gmail_id AS g FROM buyer_answers WHERE tenant_id = ? AND thread_id = ?').all(tenantId, threadId) as { g: string | null }[])
  return [...ids]
}

interface Row { message_id: string; outcome: string; status: string; resolved_at: number | null }
const ledgerOf = (rows: Row[]): LedgerEntry[] => rows.map(r => ({
  messageId: r.message_id,
  outcome: r.outcome as LedgerEntry['outcome'],
  // an answer counts against the per-thread limit from the moment it may go out: ready, in flight, sent or unknown
  sent: ['ready', 'sending', 'sent', 'uncertain'].includes(r.status),
  resolved: r.resolved_at !== null,
}))

export interface PlanResult { planned: number; ready: number; skipped?: 'no_policy' | 'no_lead' }
// Records one decision for each new inbound message of the thread. Never throws (except StaleLeaseWrite, the tick's
// lease fence): a failure is audited and nothing is
// sent for the thread (fail closed); the sync's own safety ingest (opt-outs, bounces) has already happened.
export function planThreadAnswers(db: Database.Database, tenantId: string, t: ThreadContext, d: PlanDeps): PlanResult {
  try { return planInner(db, tenantId, t, d) } catch (e) {
    if (e instanceof StaleLeaseWrite) throw e // the scheduler lost its lease: it must stop, not carry on
    try { auditAt(db, tenantId, 'answer_error', `plan: ${e instanceof Error ? e.message : 'error'}`, t.leadId, t.outreachId, d.now) } catch { /* the audit store itself failed: nothing more to record */ }
    return { planned: 0, ready: 0 }
  }
}
function planInner(db: Database.Database, tenantId: string, t: ThreadContext, d: PlanDeps): PlanResult {
  const play = db.prepare('SELECT j.id FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?').get(t.leadId, tenantId) as { id: string } | undefined
  if (!play) return { planned: 0, ready: 0, skipped: 'no_lead' }
  const conf = answerSettingsFor(db, tenantId, play.id)
  if (!conf) return { planned: 0, ready: 0, skipped: 'no_policy' }
  const flags = d.flags ?? process.env
  const mailbox = norm(t.mailbox)
  const gate = launchGate(db, tenantId, mailbox, d.now)
  if (!Array.isArray(t.messages)) throw new Error('thread_unreadable') // audited by planThreadAnswers; nothing planned
  const cls = new Map((db.prepare('SELECT gmail_id, classification FROM inbound_messages WHERE tenant_id = ? AND thread_id = ?').all(tenantId, t.threadId) as { gmail_id: string; classification: string }[]).map(r => [r.gmail_id, r.classification]))
  const messages: ThreadMessage[] = []
  const verdicts = new Map<string, { auth: 'pass' | 'fail'; verdict: string | null }>()
  for (const g of t.messages) {
    if (typeof g?.id !== 'string' || !g.id || g.id.length > 200) continue
    const from = headerValues(g, 'from')[0] ?? ''
    const own = norm((/<([^>]+)>/.exec(from)?.[1] ?? from)) === mailbox
    const c = cls.get(g.id)
    if (!own && c !== undefined && NOT_A_MESSAGE.has(c)) continue
    const authResults = headerValues(g, 'authentication-results')
    // The sync's classification of the whole message (both bodies, quoted-tail check) wins over the planner reading one
    // body: an opt-out it found is an opt-out here; anything it held for review (uncertain, negative) or could not log
    // is read as an unreadable message, which the decision escalates and never answers.
    let text = ''
    if (!own) {
      try { text = messageText(g.payload).text } catch { text = '' }
      if (c === 'opt_out') text = 'unsubscribe'
      else if (c !== 'other' && c !== 'positive') text = ''
    }
    messages.push({ id: g.id, from, text, authResults })
    if (!own) verdicts.set(g.id, { auth: senderAuthenticated(from, t.prospect, authResults) ? 'pass' : 'fail', verdict: mailboxVerdict(authResults) })
  }
  const rows = db.prepare('SELECT message_id, outcome, status, resolved_at FROM buyer_answers WHERE tenant_id = ? AND thread_id = ?').all(tenantId, t.threadId) as Row[]
  const settings = getSettings(db, tenantId)
  const baseUrl = (d.baseUrl ?? (d.env ?? process.env).PUBLIC_BASE_URL ?? 'https://dazl.ai').replace(/\/$/, '')
  const steps = conversationSteps(
    { prospect: t.prospect, mailbox, playId: play.id, messages, dazlSent: dazlSentIds(db, tenantId, t.threadId, t.outreachId), ledger: ledgerOf(rows) },
    conf.settings,
    { truth: productTruth(d.env ?? process.env), acceptedVersion: conf.acceptedVersion, signupUrl: `${baseUrl}/sign-up`, bookingUrl: settings?.booking_url ?? null },
    readiness(db, tenantId, t.prospect, gate, flags, d.now),
  )
  let planned = 0, ready = 0
  for (const s of steps) {
    if (s.outcome === 'ignored') continue
    const v = verdicts.get(s.messageId) ?? { auth: 'fail' as const, verdict: null }
    if (recordStep(db, tenantId, t, s, v, d.now)) { planned++; if (s.outcome === 'send') ready++ }
  }
  return { planned, ready }
}

// One write per step. A new message gets its row; a 'held' row is the only one a later read may change (it was never
// sent and is decided again). Every other existing row is final: the write changes nothing.
function recordStep(db: Database.Database, tenantId: string, t: ThreadContext, s: Step, v: { auth: 'pass' | 'fail'; verdict: string | null }, now: number): boolean {
  const ans = s.outcome === 'send' || s.outcome === 'approval' || s.outcome === 'held' ? s : null
  const reason = s.outcome === 'exception' ? s.reason : s.outcome === 'held' ? s.why : null
  const detail = s.outcome === 'exception' ? clip(s.detail, MAX_DETAIL) : null
  const body = ans ? ans.body : null
  if (body !== null && body.length > MAX_BODY) throw new Error('answer_too_long') // never cut an answer: the planner audits it
  const vals = [s.outcome, reason, detail, ans ? ans.topics.join(',').slice(0, 200) : null, ans ? ans.factsVersion.slice(0, 40) : null, ans ? ans.cta : null, body, v.auth, clip(v.verdict, MAX_VERDICT), s.outcome === 'send' ? 'ready' : 'recorded']
  return db.transaction(() => {
    const ins = db.prepare(`INSERT INTO buyer_answers (tenant_id, message_id, thread_id, lead_id, outreach_message_id, outcome, reason, detail, topics, facts_version, cta, body, auth, auth_verdict, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tenant_id, message_id) DO NOTHING`).run(tenantId, s.messageId, t.threadId, t.leadId, t.outreachId, ...vals, now, now)
    if (ins.changes === 1) { auditAt(db, tenantId, `answer_${s.outcome}`, reason ?? undefined, t.leadId, t.outreachId, now); return true }
    const upd = db.prepare(`UPDATE buyer_answers SET outcome = ?, reason = ?, detail = ?, topics = ?, facts_version = ?, cta = ?, body = ?, auth = ?, auth_verdict = ?, status = ?, updated_at = ?
      WHERE tenant_id = ? AND message_id = ? AND thread_id = ? AND outcome = 'held' AND status = 'recorded'`).run(...vals, now, tenantId, s.messageId, t.threadId)
    if (upd.changes === 1 && s.outcome !== 'held') auditAt(db, tenantId, `answer_${s.outcome}`, reason ?? 'was held', t.leadId, t.outreachId, now)
    return upd.changes === 1 && s.outcome !== 'held'
  })()
}

// ---------- the owner's queue and actions ----------
export interface QueueRow { message_id: string; thread_id: string; lead_id: string | null; outcome: string; reason: string | null; detail: string | null; topics: string | null; body: string | null; auth: string; status: string; created_at: number }
const QUEUE_COLS = 'message_id, thread_id, lead_id, outcome, reason, detail, topics, body, auth, status, created_at'
// Exceptions (the owner answers), approvals (written; the owner only releases) and held answers (waiting on the sender,
// consent or a limit) in three separate lists, each the tenant's own rows only.
export function answerQueue(db: Database.Database, tenantId: string): { exceptions: QueueRow[]; approvals: QueueRow[]; held: QueueRow[] } {
  const q = (where: string) => db.prepare(`SELECT ${QUEUE_COLS} FROM buyer_answers WHERE tenant_id = ? AND ${where} ORDER BY created_at DESC, message_id LIMIT 100`).all(tenantId) as QueueRow[]
  return {
    exceptions: q("outcome = 'exception' AND resolved_at IS NULL"),
    approvals: q("outcome = 'approval' AND status = 'recorded'"),
    held: q("outcome = 'held' AND status = 'recorded'"),
  }
}
export type ActionResult = 'ok' | 'not_found'
// The owner releases a written answer: it becomes ready, and goes out only through runAnswers' checks.
export function releaseAnswer(db: Database.Database, tenantId: string, messageId: string, now: number): ActionResult {
  const r = db.prepare("UPDATE buyer_answers SET status = 'ready', released_at = ?, updated_at = ? WHERE tenant_id = ? AND message_id = ? AND outcome = 'approval' AND status = 'recorded'").run(now, now, tenantId, messageId)
  if (r.changes !== 1) return 'not_found'
  auditAt(db, tenantId, 'answer_released', undefined, undefined, undefined, now)
  return 'ok'
}
// The owner closes an exception (they answered it themselves, or it needs nothing): later routine questions in the
// thread may be answered again.
export function resolveException(db: Database.Database, tenantId: string, messageId: string, now: number): ActionResult {
  const r = db.prepare("UPDATE buyer_answers SET resolved_at = ?, updated_at = ? WHERE tenant_id = ? AND message_id = ? AND outcome = 'exception' AND resolved_at IS NULL").run(now, now, tenantId, messageId)
  if (r.changes !== 1) return 'not_found'
  auditAt(db, tenantId, 'answer_exception_resolved', undefined, undefined, undefined, now)
  return 'ok'
}

// ---------- sending ----------
export interface AnswerRunResult { sent: number; held: number; cancelled: number; stopped?: string }
type Ready = { message_id: string; thread_id: string; lead_id: string | null; outreach_message_id: string | null; outcome: string; facts_version: string | null; body: string | null }
// Sends every ready answer of the tenant, each at most once. Account-wide refusals stop the pass and leave rows ready;
// a refusal that is final for one row cancels it; a temporary one leaves it ready for the next pass.
// Never throws, except a fenced write after the scheduler lost its lease (StaleLeaseWrite: the tick must stop): an
// unexpected failure (a store that cannot be read) is audited and stops the pass with stopped: 'error'. A row it had already
// claimed stays 'sending', which every later pass and every other send path treats as an unknown outcome (fail closed).
export async function runAnswers(db: Database.Database, tenantId: string, d: Deps & { flags?: Record<string, string | undefined>; env?: Record<string, string | undefined> } = {}): Promise<AnswerRunResult> {
  const now = d.now ?? Math.floor(Date.now() / 1000)
  const out: AnswerRunResult = { sent: 0, held: 0, cancelled: 0 }
  try { return await runInner(db, tenantId, d, now, out) } catch (e) {
    if (e instanceof StaleLeaseWrite) throw e // the scheduler lost its lease: it must stop, not carry on
    try { auditAt(db, tenantId, 'answer_error', `send: ${e instanceof Error ? e.message : 'error'}`.slice(0, 200), undefined, undefined, now) } catch { /* the audit store itself failed: the caller sees stopped: error */ }
    out.stopped = 'error'; return out
  }
}
async function runInner(db: Database.Database, tenantId: string, d: Deps & { flags?: Record<string, string | undefined>; env?: Record<string, string | undefined> }, now: number, out: AnswerRunResult): Promise<AnswerRunResult> {
  const flags = d.flags ?? process.env
  const stop = (why: string) => { out.stopped = why; return out }
  if (!tableExists(db, 'buyer_answers')) return stop('no_answers')
  const rows = db.prepare("SELECT message_id, thread_id, lead_id, outreach_message_id, outcome, facts_version, body FROM buyer_answers WHERE tenant_id = ? AND status = 'ready' ORDER BY created_at, message_id LIMIT 20").all(tenantId) as Ready[]
  if (!rows.length) return out
  const cancel = (r: Ready, why: string) => {
    if (db.prepare("UPDATE buyer_answers SET status = 'cancelled', reason = ?, updated_at = ? WHERE tenant_id = ? AND message_id = ? AND status = 'ready'").run(why.slice(0, 40), now, tenantId, r.message_id).changes === 1) { out.cancelled++; auditAt(db, tenantId, 'answer_cancelled', why, r.lead_id ?? undefined, r.outreach_message_id ?? undefined, now) }
  }
  for (const r of rows) {
    // account-wide: re-read before every row
    const account = accountRefusal(db, tenantId, flags, now)
    if (account) { out.held++; return stop(account) }
    const own = rowRefusal(db, tenantId, r, d.env ?? process.env, now)
    if (own === 'temporary') { out.held++; continue }
    if (own) { cancel(r, own); continue }
    const m = db.prepare('SELECT to_email, subject FROM outreach_messages WHERE tenant_id = ? AND id = ?').get(tenantId, r.outreach_message_id) as { to_email: string; subject: string } | undefined
    const thread = db.prepare('SELECT root_message_id FROM followup_threads WHERE tenant_id = ? AND thread_id = ?').get(tenantId, r.thread_id) as { root_message_id: string } | undefined
    if (!m || !thread || !r.body) { cancel(r, 'thread_missing'); continue }
    // the claim: exactly one pass moves this row from ready to sending
    const claim = db.prepare("UPDATE buyer_answers SET status = 'sending', claimed_at = ?, updated_at = ? WHERE tenant_id = ? AND message_id = ? AND status = 'ready'").run(now, now, tenantId, r.message_id)
    if (claim.changes !== 1) continue
    const unclaim = () => db.prepare("UPDATE buyer_answers SET status = 'ready', claimed_at = NULL, updated_at = ? WHERE tenant_id = ? AND message_id = ? AND status = 'sending'").run(now, tenantId, r.message_id)
    // the claim counts in the shared budget now: over it, the claim is undone (known not sent)
    if (accountSendCount(db, tenantId, now) > budget(db, tenantId, now)) { unclaim(); out.held++; return stop('daily_cap') }
    let token: string
    try { token = await getAccessToken(db, tenantId, d as OAuthDeps) } catch { unclaim(); pause(db, tenantId, 'gmail_reconnect_needed'); return stop('gmail_unavailable') }
    // everything that can change while the token was fetched is read again; a refusal here is known not sent
    const after = accountRefusal(db, tenantId, flags, now, r.message_id) ?? rowRefusal(db, tenantId, r, d.env ?? process.env, now)
    if (after) { unclaim(); if (after !== 'temporary' && !ACCOUNT_STOPS.has(after)) cancel(r, after); else out.held++; if (ACCOUNT_STOPS.has(after)) return stop(after); continue }
    const settings = getSettings(db, tenantId)!
    const acct = gmailStatus(db, tenantId)!
    const master = d.master ?? getMasterKey()
    const unsubUrl = `${(d.baseUrl ?? process.env.PUBLIC_BASE_URL ?? 'https://dazl.ai').replace(/\/$/, '')}/api/unsubscribe?t=${unsubToken(r.outreach_message_id!, master)}`
    const ref = createHash('sha256').update(`${tenantId}\n${r.message_id}`).digest('hex').slice(0, 24)
    try {
      const raw = toBase64Url(buildMime({ fromName: settings.sender_name, fromEmail: acct.email, to: m.to_email, subject: m.subject.startsWith('Re:') ? m.subject : `Re: ${m.subject}`, body: composeBody(r.body, settings, unsubUrl), messageId: `dazl.a${ref}@${acct.email.split('@')[1]}`, unsubscribeUrl: unsubUrl, date: new Date(now * 1000), inReplyTo: thread.root_message_id }))
      const sent = confirmedSendResult(await (d.sendFn ?? gmailSend)(token, raw, d.fetchImpl, r.thread_id))
      db.prepare("UPDATE buyer_answers SET status = 'sent', sent_gmail_id = ?, updated_at = ? WHERE tenant_id = ? AND message_id = ? AND status = 'sending'").run(sent.id, now, tenantId, r.message_id)
      auditAt(db, tenantId, 'answer_sent', r.facts_version ?? undefined, r.lead_id ?? undefined, r.outreach_message_id ?? undefined, now); out.sent++
    } catch {
      db.prepare("UPDATE buyer_answers SET status = 'uncertain', updated_at = ? WHERE tenant_id = ? AND message_id = ? AND status = 'sending'").run(now, tenantId, r.message_id)
      auditAt(db, tenantId, 'uncertain', 'answer outcome unknown', r.lead_id ?? undefined, r.outreach_message_id ?? undefined, now)
      pause(db, tenantId, 'uncertain_send'); return stop('uncertain_send')
    }
  }
  return out
}

const ACCOUNT_STOPS = new Set(['not_available', 'autopilot_off', 'paused', 'consent_required', 'uncertain_send', 'gmail_or_identity', 'not_calibrated', 'reply_received', 'bounce_rate', 'stop_check_unavailable', 'daily_cap'])
function budget(db: Database.Database, tenantId: string, now: number): number {
  const gate = launchGate(db, tenantId, launchMailbox(db, tenantId), now)
  return Math.min(ACCOUNT_SEND_CAP, getState(db, tenantId).daily_cap, gate.calibrated ? gate.cap : 0)
}
const launchMailbox = (db: Database.Database, tenantId: string) => { const g = gmailStatus(db, tenantId); return g?.status === 'active' ? g.email.toLowerCase() : null }
// own: this pass's own claim, which already counts in the budget and is 'sending'
function accountRefusal(db: Database.Database, tenantId: string, flags: Record<string, string | undefined>, now: number, own?: string): string | null {
  if (!autopilotAvailable(flags)) return 'not_available'
  const st = getState(db, tenantId)
  if (!st.enabled) return 'autopilot_off'
  if (st.paused) return 'paused'
  if (!st.consent_current) return 'consent_required'
  if (anyUncertainSend(db, tenantId) || db.prepare("SELECT 1 FROM buyer_answers WHERE tenant_id = ? AND (status = 'uncertain' OR (status = 'sending' AND message_id <> ?))").get(tenantId, own ?? '')) return 'uncertain_send'
  if (!getSettings(db, tenantId) || launchMailbox(db, tenantId) === null) return 'gmail_or_identity'
  const gate = launchGate(db, tenantId, launchMailbox(db, tenantId), now)
  if (!gate.calibrated) return 'not_calibrated'
  // the launch's own stops, exactly as autopilot reads them before a send
  const policyStop = calibratedStop(db, tenantId, gate)
  if (policyStop) return policyStop
  if (own === undefined && accountSendCount(db, tenantId, now) >= budget(db, tenantId, now)) return 'daily_cap'
  return null
}
// Why this row may not go out now: a final reason (the row is cancelled) or 'temporary' (left ready).
function rowRefusal(db: Database.Database, tenantId: string, r: Ready, env: Record<string, string | undefined>, now: number): string | null {
  const s = readLaunchPolicy(db, tenantId)
  const a = s?.policy.answers
  if (!s || !a || a.mode === 'off') return 'answers_off'
  if (r.outcome === 'send' && a.mode !== 'auto') return 'answers_mode_changed'
  if (r.outcome !== 'send' && r.outcome !== 'approval') return 'not_an_answer'
  const truth = productTruth(env)
  if (!r.facts_version || r.facts_version !== truth.version || s.policy.claims.productTruthVersion !== r.facts_version) return 'facts_changed'
  const m = db.prepare('SELECT to_email, test FROM outreach_messages WHERE tenant_id = ? AND id = ?').get(tenantId, r.outreach_message_id) as { to_email: string; test: number } | undefined
  if (!m) return 'thread_missing'
  const t = db.prepare('SELECT stopped FROM followup_threads WHERE tenant_id = ? AND thread_id = ?').get(tenantId, r.thread_id) as { stopped: string | null } | undefined
  if (!t) return 'thread_missing'
  if (t.stopped) return `thread_${t.stopped}`.slice(0, 40)
  // the tenant wrote in the thread by hand since this answer was planned (a later message recorded as paused)
  if (db.prepare("SELECT 1 FROM buyer_answers WHERE tenant_id = ? AND thread_id = ? AND outcome = 'paused'").get(tenantId, r.thread_id)) return 'taken_over'
  if (isSuppressed(db, tenantId, m.to_email)) return 'suppressed'
  if (!recipientAllowed(db, tenantId, m.to_email)) return 'personal_email'
  if (r.lead_id && leadHeld(db, tenantId, r.lead_id)) return 'lead_held'
  if (r.lead_id) {
    const play = db.prepare('SELECT j.id FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?').get(r.lead_id, tenantId) as { id: string } | undefined
    if (!play || !s.policy.audience.playIds.includes(play.id)) return 'not_in_audience'
  }
  const e = norm(m.to_email)
  if (s.policy.exclusions.emails.includes(e) || s.policy.exclusions.domains.includes(e.split('@')[1] ?? '')) return 'excluded'
  // #413: the safety ingest (opt-outs, bounces) must be fresh before anything goes to this address
  if (replySafetyStale(db, tenantId, m.to_email, now)) return 'temporary'
  return null
}
