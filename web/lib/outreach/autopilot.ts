import { createHash, randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { drainVerifiedPendingLifecycle, LIFECYCLE_NOT_CONVERTED } from './lifecycle.ts'
import { gmailStatus } from '../gmail/oauth.ts'
import { createDraft, approve, getSettings, isSuppressed, OutreachError, playOfferRow, sendMessage, suppress, type Deps } from './service.ts'
import { readTenantOffer } from './play-memory.ts'
import { tableExists } from './send-budget.ts'
import { draftOffer } from '../scan/play-offer-text.ts'
import { captureError } from '../ops/errors.ts'
import { ENRICH_STALE_S } from '../scan/enrichment.ts'
import { polishDraft } from './draft-llm.ts'

// Autopilot sends first-touch email to verified, business-published addresses through the user's own Gmail,
// inside hard limits. It never sends follow-ups, never re-contacts, and never touches suppressed addresses.
// Calls and social DMs are deliberately not part of it.
export const CONSENT_VERSION = '2026-10-20'
export const CONSENT_TEXT = [
  'dazl will email leads for you from your own Gmail without asking you first, within the daily limits you set, after the first sends have been approved by you.',
  'You are the sender and you are legally responsible for these emails under the laws that apply to you and your recipients (for example CASL in Canada, CAN-SPAM in the US, PECR and GDPR in the UK and EU).',
  'You will only target businesses and business roles, where the recipient published the address for business use and your message is relevant to their role.',
  'Every email carries your name, your mailing address and an unsubscribe link. Anyone who unsubscribes or bounces is never emailed again.',
  'You can pause or turn off autopilot at any time. Pausing stops sends immediately.',
]
export const ATTESTATIONS = ['business_published', 'relevant_to_role', 'responsible_sender'] as const

const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)
export const WARMUP_SENDS = (env: Record<string, string | undefined> = process.env) => num(env.AUTOPILOT_WARMUP, 10) // sends the user must approve first
export const MAX_DAILY = 50 // hard ceiling, whatever the user sets
export const DEFAULT_DAILY = 20
export const MIN_CONFIDENCE = 80

export const autopilotAvailable = (env: Record<string, string | undefined> = process.env) => env.AUTOPILOT_ENABLED === '1' && env.AUTOPILOT_KILL !== '1'

export function migrateAutopilot(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS autopilot_settings (
      tenant_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      paused INTEGER NOT NULL DEFAULT 0,
      pause_reason TEXT CHECK (pause_reason IS NULL OR length(pause_reason) <= 100),
      consent_version TEXT,
      consent_at INTEGER,
      daily_cap INTEGER NOT NULL DEFAULT ${DEFAULT_DAILY} CHECK (daily_cap BETWEEN 1 AND ${MAX_DAILY})
    );
    CREATE TABLE IF NOT EXISTS autopilot_audit (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      lead_id TEXT,
      message_id TEXT,
      action TEXT NOT NULL,
      detail TEXT CHECK (detail IS NULL OR length(detail) <= 200),
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );
    CREATE INDEX IF NOT EXISTS autopilot_audit_tenant ON autopilot_audit (tenant_id, created_at);
  `)
  // #448: the new-lead query checks each candidate lead's skipped rows, and a send's commitment reads the tenant's
  // disables: by lead and by action, never a scan of the tenant's audit (which is never pruned).
  db.exec(`
    CREATE INDEX IF NOT EXISTS autopilot_audit_lead ON autopilot_audit (tenant_id, lead_id, action);
    CREATE INDEX IF NOT EXISTS autopilot_audit_action ON autopilot_audit (tenant_id, action);
  `)
  try { db.exec('ALTER TABLE autopilot_settings ADD COLUMN followups_enabled INTEGER NOT NULL DEFAULT 0') } catch { /* exists */ }
  // #411: first touches autopilot drafted but could not send yet (a daily or per-company cap, a temporary Gmail error),
  // with why and when they may go next. next_at NULL = the user decides (warm-up drafts stay the user's to approve).
  // authority = the exact words, recipient, sender identity, offer and consent autopilot was allowed to send; any
  // change hands the draft back to the user instead of sending it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS autopilot_work (
      message_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      lead_id TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (length(reason) <= 40),
      next_at INTEGER,
      authority TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );
    CREATE INDEX IF NOT EXISTS autopilot_work_due ON autopilot_work (tenant_id, next_at);
  `)
}

export interface AutopilotState { enabled: boolean; paused: boolean; pause_reason: string | null; consent_current: boolean; daily_cap: number }
export const auditAt = (db: Database.Database, tenantId: string, action: string, detail?: string, leadId?: string, messageId?: string, at?: number) =>
  db.prepare('INSERT INTO autopilot_audit (id, tenant_id, lead_id, message_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CAST(strftime(\'%s\',\'now\') AS INTEGER)))').run(randomBytes(12).toString('hex'), tenantId, leadId ?? null, messageId ?? null, action, detail?.slice(0, 200) ?? null, at ?? null)
const audit = (db: Database.Database, tenantId: string, action: string, detail?: string, leadId?: string, messageId?: string) => auditAt(db, tenantId, action, detail, leadId, messageId)

export function getState(db: Database.Database, tenantId: string): AutopilotState {
  const r = db.prepare('SELECT enabled, paused, pause_reason, consent_version, daily_cap FROM autopilot_settings WHERE tenant_id = ?').get(tenantId) as { enabled: number; paused: number; pause_reason: string | null; consent_version: string | null; daily_cap: number } | undefined
  return { enabled: r?.enabled === 1, paused: r?.paused === 1, pause_reason: r?.pause_reason ?? null, consent_current: r?.consent_version === CONSENT_VERSION, daily_cap: r?.daily_cap ?? DEFAULT_DAILY }
}
export const recentAutopilotAudit = (db: Database.Database, tenantId: string, limit = 50) =>
  db.prepare('SELECT lead_id, message_id, action, detail, created_at FROM autopilot_audit WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(tenantId, limit) as { lead_id: string | null; message_id: string | null; action: string; detail: string | null; created_at: number }[]

// Turning on needs the current consent text, all three attestations, a connected Gmail and a sender identity.
export function enable(db: Database.Database, tenantId: string, input: { version: string; attestations: string[]; daily_cap?: number }): void {
  if (input.version !== CONSENT_VERSION || !ATTESTATIONS.every(a => input.attestations.includes(a))) throw new OutreachError('consent_required')
  if (!getSettings(db, tenantId)) throw new OutreachError('sender_identity_missing')
  if (gmailStatus(db, tenantId)?.status !== 'active') throw new OutreachError('gmail_not_connected')
  const cap = Math.min(MAX_DAILY, Math.max(1, Math.floor(input.daily_cap ?? DEFAULT_DAILY)))
  db.prepare(`INSERT INTO autopilot_settings (tenant_id, enabled, paused, pause_reason, consent_version, consent_at, daily_cap) VALUES (?, 1, 0, NULL, ?, CAST(strftime('%s','now') AS INTEGER), ?)
    ON CONFLICT(tenant_id) DO UPDATE SET enabled = 1, paused = 0, pause_reason = NULL, consent_version = excluded.consent_version, consent_at = excluded.consent_at, daily_cap = excluded.daily_cap`).run(tenantId, CONSENT_VERSION, cap)
  audit(db, tenantId, 'enabled', `cap ${cap}`)
}
export function disable(db: Database.Database, tenantId: string): void {
  db.transaction(() => {
    db.prepare('UPDATE autopilot_settings SET enabled = 0 WHERE tenant_id = ?').run(tenantId)
    audit(db, tenantId, 'disabled')
    returnHeld(db, tenantId, 'autopilot turned off: yours to approve')
  })()
  // The scheduler's view of the drain (lib/ops/scheduler-runs.ts): off is a hold, nothing is failing any more; the tick
  // will not run this tenant's drain, so its last row must not keep reporting an earlier failure. Best effort, after the
  // switch is off: the user's off switch never depends on this row (a store whose kind check is not widened yet refuses it).
  try {
    if (tableExists(db, 'scheduler_progress')) db.prepare(`INSERT INTO scheduler_progress (tenant_id, kind, last_attempt_at, last_success_at, last_error, last_outcome, last_hold, consecutive_failures, last_run_id)
      VALUES (?, 'autopilot', ?, NULL, NULL, 'hold', 'off', 0, NULL)
      ON CONFLICT (tenant_id, kind) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_error = NULL, last_outcome = 'hold', last_hold = 'off', consecutive_failures = 0`).run(tenantId, Math.floor(Date.now() / 1000))
  } catch (e) { captureError(e, { source: 'worker', where: 'autopilot:disable:progress', tenantId }) }
}
// Autopilot's held first touches (#411) go back to the user: out of its queue, unapproved where autopilot had approved
// them, one 'released' audit row each. Turning autopilot off does this for the tenant; autopilot's authority ending at a
// send's commitment does it for that draft. Nothing autopilot held is sent later on a new grant without the user.
// Warm-up holds (next_at NULL) are the user's already and stay as they are; a message in flight (sending) is not touched:
// its own pass settles it (its commitment re-reads the grant).
function returnHeld(db: Database.Database, tenantId: string, why: string): void {
  const rows = db.prepare(`SELECT w.message_id, w.lead_id FROM autopilot_work w JOIN outreach_messages m ON m.id = w.message_id AND m.tenant_id = w.tenant_id
    WHERE w.tenant_id = ? AND w.next_at IS NOT NULL AND m.status IN ('draft','approved')`).all(tenantId) as { message_id: string; lead_id: string }[]
  for (const w of rows) {
    db.prepare("UPDATE outreach_messages SET status = 'draft', approved_hash = NULL WHERE id = ? AND tenant_id = ? AND status = 'approved'").run(w.message_id, tenantId)
    db.prepare('DELETE FROM autopilot_work WHERE message_id = ? AND tenant_id = ?').run(w.message_id, tenantId)
    audit(db, tenantId, 'released', why, w.lead_id, w.message_id)
  }
}
export function pause(db: Database.Database, tenantId: string, reason = 'paused_by_user'): void {
  db.prepare('UPDATE autopilot_settings SET paused = 1, pause_reason = ? WHERE tenant_id = ?').run(reason, tenantId)
  audit(db, tenantId, 'paused', reason)
}
export function resume(db: Database.Database, tenantId: string): void {
  if (!getState(db, tenantId).consent_current) throw new OutreachError('consent_required')
  db.prepare('UPDATE autopilot_settings SET paused = 0, pause_reason = NULL WHERE tenant_id = ?').run(tenantId)
  audit(db, tenantId, 'resumed')
}

// A bounce suppresses the address for good. Three bounces in a day pause autopilot.
// (Reading bounce notices from the inbox is not built yet; this is the entry point for it.)
export function recordBounce(db: Database.Database, tenantId: string, email: string, nowS = Math.floor(Date.now() / 1000)): void {
  suppress(db, tenantId, email, 'bounce')
  audit(db, tenantId, 'bounce', email)
  const n = (db.prepare("SELECT count(*) AS n FROM autopilot_audit WHERE tenant_id = ? AND action = 'bounce' AND created_at >= ?").get(tenantId, nowS - 86400) as { n: number }).n
  if (n >= 3) pause(db, tenantId, 'bounces')
}

const sentTotal = (db: Database.Database, tenantId: string) => (db.prepare("SELECT count(*) AS n FROM outreach_messages WHERE tenant_id = ? AND status = 'sent'").get(tenantId) as { n: number }).n
// What counts against autopilot's caps: sends, sends in flight (reserved before the send path is entered; committed once
// past the final check with the request to Gmail in flight) and sends whose outcome is unknown. A reservation is released
// only when the send path refused before anything left (known not sent).
const CAP_ACTIONS = "('sent','send_committed','send_reserved','send_uncertain')"
// Autopilot sends counted in the last 24 hours (sent, reserved, or possibly sent), and the oldest of them.
const autoSent24h = (db: Database.Database, tenantId: string, now: number) => (db.prepare(`SELECT count(*) AS n FROM autopilot_audit WHERE tenant_id = ? AND action IN ${CAP_ACTIONS} AND created_at >= ?`).get(tenantId, now - 86400) as { n: number }).n
const oldestCounted = (db: Database.Database, tenantId: string, now: number) => (db.prepare(`SELECT min(created_at) AS t FROM autopilot_audit WHERE tenant_id = ? AND action IN ${CAP_ACTIONS} AND created_at >= ?`).get(tenantId, now - 86400) as { t: number | null }).t
// The same count as one send sees it at its own commitment: every send that went out, may have, or is committed (past its
// own commitment, the request to Gmail in flight), whenever it was reserved; plus the slots still only reserved before its
// own (by created_at, then id: one fixed order). Slots reserved after it do not count against it, they count it against
// themselves, so two sends not yet committed never refuse each other: the one ahead in that order goes, the other is
// refused when the cap, as it is now, has no room for it. Either way the window never exceeds the cap.
const countedAhead = (db: Database.Database, tenantId: string, now: number, own: string) => (db.prepare(`SELECT count(*) AS n FROM autopilot_audit a WHERE a.tenant_id = ? AND a.action IN ${CAP_ACTIONS} AND a.created_at >= ? AND a.id <> ?
  AND (a.action <> 'send_reserved' OR (a.created_at, a.id) < (SELECT o.created_at, o.id FROM autopilot_audit o WHERE o.id = ?))`).get(tenantId, now - 86400, own, own) as { n: number }).n
// The last time this company was emailed (sent, sending or uncertain) or had an autopilot send reserved, if within 7 days.
// own: this send's own message and reservation, left out when the check runs at its own commitment.
const domainLastSent = (db: Database.Database, tenantId: string, domain: string, now: number, own = { reservation: '', message: '' }): number | null => {
  const m = (db.prepare("SELECT max(claimed_at) AS t FROM outreach_messages WHERE tenant_id = ? AND status IN ('sent','sending','uncertain') AND to_email LIKE ? AND claimed_at >= ? AND id <> ?").get(tenantId, `%@${domain}`, now - 7 * 86400, own.message) as { t: number | null }).t
  const r = (db.prepare(`SELECT max(created_at) AS t FROM autopilot_audit WHERE tenant_id = ? AND action IN ${CAP_ACTIONS} AND detail = ? AND created_at >= ? AND id <> ?`).get(tenantId, domain, now - 7 * 86400, own.reservation) as { t: number | null }).t
  return m === null && r === null ? null : Math.max(m ?? 0, r ?? 0)
}

// First-touch backlog holds. A hold records why the draft waits, when it may next be tried, the consent version the
// hold was recorded under and the offer the draft's words were created for. The scheduler drain acts only on holds it
// can name; warmup (manual-approval) drafts and pre-existing drafts with no hold record are never auto-sent.
const TRANSIENT_RETRY_S = 900
const MAX_SEND_RETRIES = 3
export const HOLD_REASONS = ['warmup_manual', 'daily_cap', 'held_domain_cap', 'send_failed', 'reply_sync_stale'] as const

// The offer inputs a first-touch draft is created under, exactly as createDraftInner resolves them. A null means the
// offer could not be read: such a draft is never drained, since its authority cannot be re-verified.
export function offerHashFor(db: Database.Database, tenantId: string, leadId: string): string | null { // exported for migration-bridge tests seeding pre-merge hold rows
  try {
    const r = draftOffer(playOfferRow(db, tenantId, leadId), readTenantOffer(db, tenantId))
    if (r.refuse) return null
    return createHash('sha256').update(r.offer ?? '').digest('hex')
  } catch { return null }
}

function setHold(db: Database.Database, tenantId: string, msgId: string, leadId: string, reason: typeof HOLD_REASONS[number], until: number | null): void {
  db.prepare("UPDATE outreach_messages SET hold_reason = ?, hold_until = ?, hold_policy = ?, offer_hash = ? WHERE id = ? AND tenant_id = ? AND status IN ('draft','approved')")
    .run(reason, until, CONSENT_VERSION, reason === 'warmup_manual' ? null : offerHashFor(db, tenantId, leadId), msgId, tenantId)
}

// Earliest time the daily autopilot cap can have a free slot: when the oldest counted send leaves the 24h window.
function dailyCapDueAt(db: Database.Database, tenantId: string, now: number): number {
  const t = (db.prepare("SELECT MIN(created_at) AS t FROM autopilot_audit WHERE tenant_id = ? AND action = 'sent' AND created_at >= ?").get(tenantId, now - 86400) as { t: number | null }).t
  return (t ?? now) + 86400
}
const domainSentRecently = (db: Database.Database, tenantId: string, domain: string, now: number) =>
  !!db.prepare("SELECT 1 FROM outreach_messages WHERE tenant_id = ? AND status IN ('sent','sending','uncertain') AND to_email LIKE ? AND claimed_at >= ?").get(tenantId, `%@${domain}`, now - 7 * 86400)
function domainCapDueAt(db: Database.Database, tenantId: string, domain: string, now: number): number {
  const t = (db.prepare("SELECT MAX(claimed_at) AS t FROM outreach_messages WHERE tenant_id = ? AND status IN ('sent','sending','uncertain') AND to_email LIKE ? AND claimed_at >= ?").get(tenantId, `%@${domain}`, now - 7 * 86400) as { t: number | null }).t
  return (t ?? now) + 7 * 86400
}
// Account-level daily cap (send-budget accountSendCount's rolling window over all four send tables): due when the
// oldest send still inside the window leaves it. A re-hold at this time keeps the original cap semantics; it never
// consumes a retry attempt, because the cap holding is legitimate, not a fault of the draft.
function accountCapDueAt(db: Database.Database, tenantId: string, now: number): number {
  let oldest: number | null = null
  const take = (t: number | null | undefined) => { if (t != null && (oldest === null || t < oldest)) oldest = t }
  take((db.prepare("SELECT MIN(COALESCE(claimed_at,sent_at,created_at)) AS t FROM outreach_messages WHERE tenant_id = ? AND status IN ('sent','sending','uncertain') AND COALESCE(claimed_at,sent_at,created_at) >= ?").get(tenantId, now - 86400) as { t: number | null }).t)
  if (tableExists(db, 'followup_messages')) take((db.prepare("SELECT MIN(created_at) AS t FROM followup_messages WHERE tenant_id = ? AND status IN ('sent','sending','uncertain') AND created_at >= ?").get(tenantId, now - 86400) as { t: number | null }).t)
  if (tableExists(db, 'sequence_steps')) take((db.prepare("SELECT MIN(COALESCE(claimed_at,sent_at,created_at)) AS t FROM sequence_steps WHERE tenant_id = ? AND step > 1 AND status IN ('sent','sending','uncertain') AND COALESCE(claimed_at,sent_at,created_at) >= ?").get(tenantId, now - 86400) as { t: number | null }).t)
  if (tableExists(db, 'reopen_messages')) take((db.prepare("SELECT MIN(COALESCE(sent_at,created_at)) AS t FROM reopen_messages WHERE tenant_id = ? AND status IN ('sent','approved') AND COALESCE(sent_at,created_at) >= ?").get(tenantId, now - 86400) as { t: number | null }).t)
  return (oldest ?? now) + 86400
}

// Retry eligibility is PROOF-based, never assumed. sendClaimed (service.ts) throws only via release(), which runs
// solely while Gmail has provably not accepted the message: the claim is rolled back to 'approved' with claimed_at
// NULL, and 400/404/429 are Gmail's own refusals before acceptance. A timeout, transport error, 5xx, malformed
// success or any other ambiguous provider outcome is marked 'uncertain' with the tenant paused inside sendClaimed and
// is NEVER thrown - so no ambiguous outcome can ever enter this retry path. The retry-eligible codes below are the
// transient subset of those proven-not-sent refusals; every other named refusal is a permanent policy verdict and the
// draft is skipped instead of stranded. Non-OutreachError exceptions are not classified here at all: they propagate
// to the scheduler as failures.
const TRANSIENT_RELEASE_CODES: ReadonlySet<string> = new Set(['gmail_unavailable', 'gmail_rate_limited', 'daily_cap', 'already_sending']) // classified in holdSendFailure: caps/claim-conflicts wait without consuming retries; provider faults get bounded backoff
function holdSendFailure(db: Database.Database, tenantId: string, msgId: string, leadId: string, code: string, now: number): 'held' | 'skipped' {
  // Claim conflict: another tick owns this send right now. The loser writes nothing (setHold's status filter excludes
  // a claimed row), consumes no attempt and never touches the winner's claim; it simply looks again later.
  if (code === 'already_sending') { setHold(db, tenantId, msgId, leadId, 'send_failed', now + TRANSIENT_RETRY_S); return 'held' }
  // Legitimate cap still in force: wait for the window to roll. Never counts toward retry exhaustion.
  if (code === 'daily_cap') { setHold(db, tenantId, msgId, leadId, 'daily_cap', accountCapDueAt(db, tenantId, now)); return 'held' }
  // #413: safety ingest behind - hold without consuming retries; the draft re-runs once reply_sync succeeds again.
  if (code === 'reply_sync_stale') { setHold(db, tenantId, msgId, leadId, 'reply_sync_stale', now + TRANSIENT_RETRY_S); return 'held' }
  if (code === 'gmail_unavailable' || code === 'gmail_rate_limited') {
    // Exhaustion counts only this message's own transient provider faults (audited just above), never the attempts
    // column: a claim released for a legitimate cap or a lost race is not a fault and must not move a draft toward skipping.
    const tries = (db.prepare("SELECT count(*) AS n FROM autopilot_audit WHERE tenant_id = ? AND message_id = ? AND action = 'send_failed' AND detail IN ('gmail_unavailable','gmail_rate_limited')").get(tenantId, msgId) as { n: number }).n
    if (tries >= MAX_SEND_RETRIES) {
      db.prepare("UPDATE outreach_messages SET status = 'skipped', error = 'retry_exhausted', hold_reason = NULL, hold_until = NULL WHERE id = ? AND tenant_id = ? AND status IN ('draft','approved')").run(msgId, tenantId)
      auditAt(db, tenantId, 'skipped', 'retry_exhausted', leadId, msgId, now)
      return 'skipped'
    }
    setHold(db, tenantId, msgId, leadId, 'send_failed', now + TRANSIENT_RETRY_S * tries)
    return 'held'
  }
  db.prepare("UPDATE outreach_messages SET status = 'skipped', error = ?, hold_reason = NULL, hold_until = NULL WHERE id = ? AND tenant_id = ? AND status IN ('draft','approved')").run(code.slice(0, 200), msgId, tenantId)
  auditAt(db, tenantId, 'skipped', code, leadId, msgId, now)
  return 'skipped'
}

export interface RunResult { sent: number; held: number; skipped: number; stopped?: string }

// What autopilot was allowed to send for this draft: its exact words and recipient, the sender identity and offer they
// carry, the Gmail account it goes out from, and the consent version. Recomputed before a held draft is sent; a different
// value hands it back to the user.
function authorityInputs(db: Database.Database, tenantId: string, messageId: string) {
  const m = db.prepare(`SELECT m.to_email, m.subject, m.body, m.lead_id, j.seller FROM outreach_messages m
    JOIN leads l ON l.id = m.lead_id JOIN scan_jobs j ON j.id = l.scan_job_id AND j.user_id = m.tenant_id
    WHERE m.id = ? AND m.tenant_id = ?`).get(messageId, tenantId) as { to_email: string; subject: string; body: string; lead_id: string; seller: string | null } | undefined
  if (!m) return null
  // The offer the words were actually drafted under: the tenant's effective offer (Memory positioning wins over the
  // profile), the same value draftOffer gave createDraft and offerHashFor hashed pre-merge. A scan-job snapshot alone
  // misses a tenant editing their positioning while a send is held - the old drain caught that, the fingerprint must too.
  let offer: string | null
  try {
    const r = draftOffer(playOfferRow(db, tenantId, m.lead_id), readTenantOffer(db, tenantId))
    if (r.refuse) return null // the authority cannot be re-read: fail closed, as if it had ended
    offer = r.offer ?? null
  } catch { return null }
  const s = getSettings(db, tenantId) as { sender_name?: string; postal_address?: string } | undefined
  return { to_email: m.to_email, subject: m.subject, body: m.body, offer, seller: m.seller, sender_name: s?.sender_name ?? null, postal_address: s?.postal_address ?? null, gmail: gmailSender(db, tenantId) }
}
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
export function draftAuthority(db: Database.Database, tenantId: string, messageId: string): string | null {
  const a = authorityInputs(db, tenantId, messageId)
  return a && sha([CONSENT_VERSION, a.to_email, a.subject, a.body, a.offer, a.seller, a.sender_name, a.postal_address, a.gmail])
}
// The same, without the words: what a new draft's polish (which rewrites only the words) must leave unchanged.
function draftContext(db: Database.Database, tenantId: string, messageId: string): string | null {
  const a = authorityInputs(db, tenantId, messageId)
  return a && sha([CONSENT_VERSION, a.to_email, a.offer, a.seller, a.sender_name, a.postal_address, a.gmail])
}
// The address of the connected Gmail account (the one the send path sends from), or null when none is connected.
function gmailSender(db: Database.Database, tenantId: string): string | null {
  return (db.prepare('SELECT email FROM gmail_accounts WHERE tenant_id = ?').get(tenantId) as { email: string } | undefined)?.email.toLowerCase() ?? null
}

// A claim on a work row is held this long; a pass that died mid-way frees it after that.
const CLAIM_S = 600
// Known-not-sent, temporary refusals of the send path: retried with backoff, at most RETRY_MAX times.
const TRANSIENT = new Set(['gmail_unavailable', 'gmail_rate_limited'])
const RETRY_MAX = 3
// The account must reconnect Gmail or resume: the work stays due and goes on the first pass after that.
const WAIT_FOR_USER = new Set(['gmail_reconnect_needed', 'gmail_not_connected', 'paused'])
// The tenant's own grant ended while the send was in progress (turned off, consent no longer current): known not sent,
// the slot is released, and the draft goes back to the user, unapproved and out of the queue. A later grant does not
// send what was held under the old one.
const AUTHORITY_RETURNS = new Set(['autopilot_off', 'consent_required'])
// Not the tenant's decision, or the send's own standing gone (the operator switch or kill switch off, its reserved slot
// lost, the authority unreadable): known not sent, the slot released, the draft held and unapproved until autopilot runs
// again and reads it afresh.
const AUTHORITY_ENDED = new Set(['autopilot_unavailable', 'reservation_lost', 'authority_unreadable'])
// The new-lead query (step 2 of a pass). Parameters: tenant, now - ENRICH_STALE_S, MIN_CONFIDENCE, tenant (sitecrawl),
// tenant, tenant, now - SKIP_ERROR_S, now - SKIP_RETRY_S. A lead whose own contact is absent or not an email is admitted
// when its sitecrawl recorded a published email; createDraft picks that address with the same checks a manual draft
// passes. A converted prospect is never a candidate (LIFECYCLE_NOT_CONVERTED, #417). Only leads of finished scans whose post-finish enrichment (buyer fit, the
// required sales/hiring gate) is not running: the runner marks the scan done before that stage and records the gate in
// it, so a tick during a running scan or its enrichment must not read a gate not yet run as a refusal. An enrichment
// that never finished (a crash) stops holding its leads after ENRICH_STALE_S, the store's own staleness rule. Never a
// scan that carries a run budget or is trial-funded: the runner does not start autopilot for those (its drafting and
// sends are outside the budget; lib/scan/runner.ts jobStartsAutopilot, the same rule), so the drain must not either. Its
// skipped-row check is by lead on autopilot_audit_lead (test: the query plan).
// Evaluated lazily: the fragment comes from lifecycle.ts, whose module is still initializing when this one loads
// (autopilot -> lifecycle -> sequences -> lifecycle). A module-level template would read it in its TDZ.
let newLeadsSqlCache: string | null = null
export function newLeadsSql(): string {
  return newLeadsSqlCache ??= `SELECT l.id, l.contact FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
     WHERE j.user_id = ? AND j.status = 'done' AND (j.enrich_started_at IS NULL OR j.enrich_finished_at IS NOT NULL OR j.enrich_started_at < ?)
       AND j.run_budget IS NULL AND j.funded_by <> 'trial'
       AND l.evidence_excerpt IS NOT NULL AND l.confidence >= ? AND l.quarantined_at IS NULL
       AND (l.contact IS NOT NULL OR EXISTS (SELECT 1 FROM lead_enrichments e WHERE e.lead_id = l.id AND e.tenant_id = ? AND e.connector = 'sitecrawl' AND e.kind = 'email'))
       AND ${LIFECYCLE_NOT_CONVERTED}
       AND NOT EXISTS (SELECT 1 FROM outreach_messages m WHERE m.tenant_id = ? AND m.lead_id = l.id)
       AND NOT EXISTS (SELECT 1 FROM autopilot_audit a WHERE a.tenant_id = ? AND a.lead_id = l.id AND a.action = 'skipped'
         AND (a.detail IN ('personal_email','not_sales_contact','suppressed','no_email_contact')
           OR (a.detail IN ('error','offer_unreadable') AND a.created_at > ?)
           OR (a.detail NOT IN ('error','offer_unreadable') AND a.created_at > ? AND a.created_at > COALESCE(l.human_confirmed_at, 0))))
     ORDER BY l.score DESC LIMIT 25`
}
// Refusals of the draft path that never change for a lead (createDraft's draftChecks: a personal address, not a sales
// contact, suppressed, no address): recorded once, the lead is the user's from then on. Every other refusal (currentness
// or domain to confirm, ungraded, a sales/hiring gate not passed yet (held-state.ts: a held lead clears when the gate
// runs again and passes), evidence the user can confirm, an offer conflict) is tried again: after SKIP_RETRY_S, or at
// once when the lead was confirmed by the user at or after the refusal; a store error ('error') or an unreadable offer
// after SKIP_ERROR_S (the next tick).
const SKIP_RETRY_S = 3600, SKIP_ERROR_S = 600
// The authority could not be read at the send commitment (the store failed): fail closed, as if it had ended. Known not
// sent, the slot released, the draft held and unapproved; the next pass reads it again.
const AUTHORITY_UNREADABLE = 'authority_unreadable'
// What autopilot was allowed to send changed while the send was in progress (draftAuthority no longer the stored value):
// known not sent, the slot is released, and the draft goes back to the user unapproved.
const AUTHORITY_CHANGED = 'authority_changed'
// The volume limits re-read at the send commitment, after the token refresh: the daily cap as the store has it now, and
// the one-email-per-company-per-7-days rule against sends that went out meanwhile. Refused there: known not sent, the
// slot released, the draft unapproved and held until the limit has room, as when a cap holds it before a slot is reserved.
const VOLUME_AT_SEND = new Map<string, 'daily_cap' | 'domain_cap'>([['volume_daily_cap', 'daily_cap'], ['volume_domain_cap', 'domain_cap']])

// One pass for this tenant: first the held first touches that are due again (#411), then verified leads that have no
// message yet. Safe to call repeatedly and from two places at once (the scheduler tick and a finishing scan): a work row
// is claimed before it is touched, a lead can have only one draft, and the send path claims each message once.
// keep: awaited before each message (the scheduler's lease heartbeat); if it throws, the pass ends there, nothing started.
export async function runAutopilot(db: Database.Database, tenantId: string, businessName: string, d: Deps & { flags?: Record<string, string | undefined>; keep?: () => Promise<void> } = {}): Promise<RunResult> {
  drainVerifiedPendingLifecycle(db) // #417: complete verified conversions before candidate selection
  const out: RunResult = { sent: 0, held: 0, skipped: 0 }
  const env = d.flags ?? process.env
  const now = d.now ?? Math.floor(Date.now() / 1000)
  const audit = (db2: Database.Database, t: string, a: string, dt?: string, l?: string, m?: string) => auditAt(db2, t, a, dt, l, m, now)
  const st = getState(db, tenantId)
  const stop = (why: string): RunResult => { out.stopped = why; return out }
  if (!autopilotAvailable(env)) return stop('not_available') // operator flag or kill switch
  if (!st.enabled) return stop('off')
  if (st.paused) return stop('paused')
  if (!st.consent_current) return stop('consent_required')
  const uncertain = db.prepare("SELECT 1 FROM outreach_messages WHERE tenant_id = ? AND status = 'uncertain'").get(tenantId)
  if (uncertain) { pause(db, tenantId, 'uncertain_send'); return stop('uncertain_send') }
  // The grant this pass runs under: a disable since it started (even with autopilot on again by now) ends it, at the
  // commitment and in what is done with a refused draft. (Counted from the audit: a cap change through enable() is not it.)
  const disables = () => (db.prepare("SELECT count(*) AS n FROM autopilot_audit WHERE tenant_id = ? AND action = 'disabled'").get(tenantId) as { n: number }).n
  const grant = disables()
  const regranted = () => disables() !== grant
  const live = () => { const s2 = getState(db, tenantId); return !s2.paused && s2.enabled && autopilotAvailable(env) }

  // auth: the authority fingerprint the hold is kept under. Inside deliver this is the one autopilot checked (expected),
  // never a fresh read: a change during the Gmail request must not be stamped in as the authority the retry compares to.
  const hold = (id: string, leadId: string, reason: string, nextAt: number | null, attempts = 0, auth: string | null = draftAuthority(db, tenantId, id)) => {
    // No authority to hold it under (the message or its play is gone): nothing to keep, but say so rather than nothing.
    if (!auth) { audit(db, tenantId, 'not_held', `${reason}: message or play missing`, leadId, id); return }
    db.prepare(`INSERT INTO autopilot_work (message_id, tenant_id, lead_id, reason, next_at, authority, attempts, claimed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT (message_id) DO UPDATE SET reason = excluded.reason, next_at = excluded.next_at, attempts = excluded.attempts, claimed_at = NULL`).run(id, tenantId, leadId, reason, nextAt, auth, attempts, now)
  }
  const drop = (id: string) => db.prepare('DELETE FROM autopilot_work WHERE message_id = ? AND tenant_id = ?').run(id, tenantId)
  // Autopilot gives a draft back: out of its queue, and unapproved again if autopilot had approved it, so the user decides.
  const backToUser = (id: string) => { drop(id); db.prepare("UPDATE outreach_messages SET status = 'draft', approved_hash = NULL WHERE id = ? AND tenant_id = ? AND status = 'approved'").run(id, tenantId) }

  // Autopilot may send right now: on, not paused, consent current, operator flag on. Re-read after every await.
  const authority = (): string | null => {
    const s2 = getState(db, tenantId)
    return !autopilotAvailable(env) ? 'autopilot_unavailable' : !s2.enabled ? 'autopilot_off' : s2.paused ? 'paused' : !s2.consent_current ? 'consent_required' : null
  }
  // Changed since autopilot took its authority: the user's to approve.
  const release = (id: string, leadId: string, why = 'changed since autopilot drafted it: yours to approve') => {
    backToUser(id); out.held++
    // Once per message (a lead has one draft, so by lead, on the lead index): disable() may have released it already
    // (returnHeld) while this pass was in its refresh.
    if (!db.prepare("SELECT 1 FROM autopilot_audit WHERE tenant_id = ? AND lead_id = ? AND action = 'released'").get(tenantId, leadId)) audit(db, tenantId, 'released', why, leadId, id)
  }
  const ENDED_WHY = 'autopilot stopped before it was sent: yours to approve'
  const keepHeld = (id: string, leadId: string, code: string, attempts: number, nextAt: number = now, auth?: string) => {
    hold(id, leadId, code, nextAt, attempts, auth)
    db.prepare("UPDATE outreach_messages SET status = 'draft', approved_hash = NULL WHERE id = ? AND tenant_id = ? AND status = 'approved'").run(id, tenantId)
  }
  // The volume limits as the store has them now: the daily cap (autopilot_settings.daily_cap, re-read every time, never
  // the value at the start of the pass) and one email per company per 7 days. Run before a slot is reserved, and again at
  // the send commitment with this send's own reservation and message left out (they count for every other send, not for
  // itself): a cap lowered, or another send to the company, while the request was in flight refuses the send.
  const capHold = (domain: string, own?: { reservation: string; message: string }): { held: 'daily_cap' | 'domain_cap'; at: number; cap: number } | null => {
    const cap = getState(db, tenantId).daily_cap
    const n = own ? countedAhead(db, tenantId, now, own.reservation) : autoSent24h(db, tenantId, now)
    // Due again when the oldest counted send of the last 24 hours drops out of the window (inclusive at its edge).
    if (n >= cap) return { held: 'daily_cap', at: (oldestCounted(db, tenantId, now) ?? now) + 86400 + 1, cap }
    const last = domainLastSent(db, tenantId, domain, now, own)
    return last === null ? null : { held: 'domain_cap', at: last + 7 * 86400 + 1, cap }
  }

  // The gates and the send, for a draft autopilot made (new, or held earlier). 'stop' ends the pass, with out.stopped set.
  // expected: the draft's authority fingerprint autopilot holds (the stored one for a held draft; the one taken after the
  // polish for a new draft). Rechecked here and, through authorize, at the send commitment after the token refresh.
  // held: the draft came from the queue (its work row must still be there at the commitment: disable() removes it).
  const deliver = async (id: string, leadId: string, attempts: number, expected: string, held = false): Promise<'stop' | void> => {
    // A draft polished (or a held one re-checked) across an await: autopilot may have been turned off meanwhile.
    const before = authority()
    if (before) {
      out.stopped = before
      if (AUTHORITY_RETURNS.has(before)) release(id, leadId, ENDED_WHY)
      else { out.held++; if (before === 'paused') hold(id, leadId, before, now, attempts, expected); else keepHeld(id, leadId, before, attempts, now, expected) }
      return 'stop'
    }
    if (draftAuthority(db, tenantId, id) !== expected) { release(id, leadId); return }
    const msg = db.prepare('SELECT to_email, status FROM outreach_messages WHERE id = ? AND tenant_id = ?').get(id, tenantId) as { to_email: string; status: string }
    const to = msg.to_email
    // Warm-up drafts are the user's to approve: never sent by autopilot later, whatever happens to the caps.
    if (sentTotal(db, tenantId) < WARMUP_SENDS(env)) { out.held++; hold(id, leadId, 'warmup', null, 0, expected); audit(db, tenantId, 'held_warmup', 'needs your approval', leadId, id); return }
    if (isSuppressed(db, tenantId, to)) { out.skipped++; drop(id); audit(db, tenantId, 'skipped', 'suppressed', leadId, id); return }
    const domain = to.split('@')[1]
    // The daily cap and the one-email-per-company-per-7-days rule are checked and this send reserved in one write
    // transaction (BEGIN IMMEDIATE), before any await: two passes at once (a tick and a finishing scan, or two processes)
    // cannot both read room for one more send.
    const admit = db.transaction((): { held: 'daily_cap' | 'domain_cap'; at: number; cap: number } | { reservation: string } => {
      const h = capHold(domain)
      if (h) return h
      const reservation = randomBytes(12).toString('hex')
      db.prepare("INSERT INTO autopilot_audit (id, tenant_id, lead_id, message_id, action, detail, created_at) VALUES (?, ?, ?, ?, 'send_reserved', ?, ?)").run(reservation, tenantId, leadId, id, domain, now)
      return { reservation }
    }).immediate()
    if ('held' in admit) {
      out.held++; hold(id, leadId, admit.held, admit.at, attempts, expected)
      if (admit.held === 'domain_cap') { audit(db, tenantId, 'held_domain_cap', 'one email per company per 7 days', leadId, id); return }
      audit(db, tenantId, 'daily_cap', `cap ${admit.cap}`, leadId, id); out.stopped = 'daily_cap'; return 'stop'
    }
    const settle = (action: 'sent' | 'send_uncertain' | null) => action
      ? db.prepare('UPDATE autopilot_audit SET action = ? WHERE id = ? AND tenant_id = ?').run(action, admit.reservation, tenantId)
      : db.prepare("DELETE FROM autopilot_audit WHERE id = ? AND tenant_id = ? AND action IN ('send_reserved','send_committed')").run(admit.reservation, tenantId)
    // Writes after the send path answered are each made on their own: one refused (the store busy, the scheduler's lease
    // lost) does not skip the others, and the first such error ends the pass once the rest are done.
    const guarded = () => { const errors: unknown[] = []; return { step: (f: () => unknown) => { try { f() } catch (e) { errors.push(e) } }, done: () => { if (errors.length) throw errors[0] } } }
    const approvedHere = msg.status === 'draft'
    let r: 'sent' | 'uncertain'
    try {
      if (approvedHere) approve(db, tenantId, id)
      // Only from the Gmail account the authority was taken with: the send path refuses at commitment if it changed.
      // authorize: re-read by the send path as its last check, after the token refresh, immediately before Gmail: autopilot's
      // own authority, the draft's fingerprint, this send's reservation, and the volume limits as they are now.
      // A read that fails there refuses the send (fail closed): no send goes on an authority nobody could read.
      // The volume check and the commit mark are one write transaction (BEGIN IMMEDIATE, synchronous, nothing awaited
      // between it and the request to Gmail): the reservation becomes 'send_committed', which every other pass's
      // commitment counts whatever its order. A mark that fails (the row gone, or the write refused) is no send.
      const volumeNow = () => { const h = capHold(domain, { reservation: admit.reservation, message: id }); return h ? `volume_${h.held}` : null }
      const commit = db.transaction((): string | null => (regranted() || (held && !db.prepare('SELECT 1 FROM autopilot_work WHERE message_id = ? AND tenant_id = ?').get(id, tenantId)) ? 'autopilot_off' : null)
        ?? volumeNow()
        ?? (db.prepare("UPDATE autopilot_audit SET action = 'send_committed' WHERE id = ? AND tenant_id = ? AND action = 'send_reserved'").run(admit.reservation, tenantId).changes === 1 ? null : 'reservation_lost'))
      const authorize = (): string | null => {
        try { return authority() ?? (draftAuthority(db, tenantId, id) !== expected ? AUTHORITY_CHANGED : null) ?? commit.immediate() }
        catch { return AUTHORITY_UNREADABLE }
      }
      r = await sendMessage(db, tenantId, id, { ...d, expectSender: gmailSender(db, tenantId) ?? '', authorize })
    } catch (e) {
      const code = e instanceof OutreachError ? e.code : 'error'
      const g = guarded()
      // The draft first: autopilot's approval comes off it whatever else fails below (the user must never find a draft
      // approved by autopilot that is not going). Then the slot: the send path's refusals (OutreachError) come before
      // anything is sent, so the reservation is released; anything else may have happened after the bytes left, so it
      // keeps counting. Then the record and the hold.
      if (approvedHere) g.step(() => db.prepare("UPDATE outreach_messages SET status = 'draft', approved_hash = NULL WHERE id = ? AND tenant_id = ? AND status = 'approved'").run(id, tenantId))
      g.step(() => settle(e instanceof OutreachError ? null : 'send_uncertain'))
      g.step(() => audit(db, tenantId, 'send_failed', code, leadId, id))
      let ends = false
      g.step(() => {
        // A volume limit refused it at commitment (the slot is released above): held until the limit has room, unapproved.
        const vol = VOLUME_AT_SEND.get(code)
        if (vol) { keepHeld(id, leadId, vol, attempts, capHold(domain)?.at ?? now, expected); out.held++; if (vol === 'daily_cap') { out.stopped = vol; ends = true } return }
        // The sending account's own 24h limit (service.ts 'daily_cap'): the same failure class as a volume refusal -
        // capacity, known not sent (OutreachError is thrown only before Gmail accepted anything). Held without
        // consuming retries until the account window has room, exactly as the pre-merge holdSendFailure kept it
        // (accountCapDueAt); it must never run out bounded retries and land backToUser while the refusal is only the
        // window. The pass stops: every later send this tick would hit the same account limit.
        if (code === 'daily_cap') { keepHeld(id, leadId, 'daily_cap', attempts, accountCapDueAt(db, tenantId, now), expected); out.held++; out.stopped = 'daily_cap'; ends = true; return }
        if (AUTHORITY_RETURNS.has(code) || regranted()) { release(id, leadId, ENDED_WHY); out.stopped = AUTHORITY_RETURNS.has(code) ? code : 'autopilot_off'; ends = true; return }
        if (AUTHORITY_ENDED.has(code)) { keepHeld(id, leadId, code, attempts, now, expected); out.held++; out.stopped = code; ends = true; return }
        if (WAIT_FOR_USER.has(code)) { hold(id, leadId, code, now, attempts, expected); if (code !== 'paused') pause(db, tenantId, code); out.held++; out.stopped = code; ends = true; return }
        if (TRANSIENT.has(code) && attempts + 1 < RETRY_MAX) { hold(id, leadId, code, now + 3600 * 2 ** attempts, attempts + 1, expected); out.held++; return }
        // Any other refusal (a check now holds the lead or the address, the sending account changed, retries ran out):
        // the user decides.
        backToUser(id); out.held++
      })
      g.done()
      return ends ? 'stop' : undefined
    }
    // Sent, or possibly sent: the message's own status is already written by the send path. The record follows: the
    // reservation becomes the send's record ('sent', counted once) or stays counted as possibly sent; an unknown outcome
    // is never retried by autopilot, the message stays uncertain for the user and autopilot pauses.
    const g = guarded()
    if (r === 'sent') { out.sent++; g.step(() => settle('sent')); g.step(() => drop(id)) }
    else { g.step(() => settle('send_uncertain')); g.step(() => audit(db, tenantId, 'uncertain', 'send outcome unknown', leadId, id)); g.step(() => pause(db, tenantId, 'uncertain_send')); g.step(() => drop(id)); out.stopped = 'uncertain_send' }
    g.done()
    if (r !== 'sent') return 'stop'
    // #414: a proven first-touch send enrolls the bounded cold follow-up sequence, only under the tenant-accepted
    // AUTO_SEQUENCE_POLICY. Deferred import: sequences.ts already imports this module. Enrollment is best-effort -
    // it must never pause the tenant or affect the send that just happened.
    try { (await import('./sequences.ts')).enrollColdSequence(db, tenantId, id, { businessName }) }
    catch (e) { audit(db, tenantId, 'sequence_enroll_failed', e instanceof Error ? e.message.slice(0, 40) : 'error', leadId, id) }
  }

  // 1. Held first touches that are due again.
  const due = db.prepare('SELECT message_id, lead_id, authority, attempts FROM autopilot_work WHERE tenant_id = ? AND next_at IS NOT NULL AND next_at <= ? AND (claimed_at IS NULL OR claimed_at < ?) ORDER BY next_at, created_at LIMIT 25')
    .all(tenantId, now, now - CLAIM_S) as { message_id: string; lead_id: string; authority: string; attempts: number }[]
  for (const w of due) {
    if (!live()) return stop('paused')
    // Claimed by this pass only: another pass (a second tick, a finishing scan) skips it.
    if (db.prepare('UPDATE autopilot_work SET claimed_at = ? WHERE message_id = ? AND tenant_id = ? AND (claimed_at IS NULL OR claimed_at < ?)').run(now, w.message_id, tenantId, now - CLAIM_S).changes !== 1) continue
    const m = db.prepare('SELECT status FROM outreach_messages WHERE id = ? AND tenant_id = ?').get(w.message_id, tenantId) as { status: string } | undefined
    // Sent, skipped or deleted by the user meanwhile: nothing left for autopilot.
    if (!m || (m.status !== 'draft' && m.status !== 'approved')) { drop(w.message_id); continue }
    // Gmail disconnected: no sending account to check against yet. The work waits; reconnecting the same address resumes
    // it, another address releases it below.
    if (gmailSender(db, tenantId) === null) { db.prepare('UPDATE autopilot_work SET claimed_at = NULL WHERE message_id = ? AND tenant_id = ?').run(w.message_id, tenantId); out.held++; continue }
    if (draftAuthority(db, tenantId, w.message_id) !== w.authority) { release(w.message_id, w.lead_id); continue }
    await d.keep?.()
    if (await deliver(w.message_id, w.lead_id, w.attempts, w.authority, true) === 'stop') return out
  }

  // 2. Verified leads with no message yet, and none autopilot skipped: a lead the draft path refused for good (a personal
  // address, not a sales contact, suppressed, no address) is recorded once and left to the user; one refused for a
  // reason that can change is tried again later (SKIP_RETRY_S, or as soon as the user confirmed the lead after the
  // refusal), a store error on the next tick. So a pass every tick does not retry the same refusals, write the same
  // audit rows, or hold the 25 slots from leads it could send to.
  const leads = db.prepare(newLeadsSql()).all(tenantId, now - ENRICH_STALE_S, MIN_CONFIDENCE, tenantId, tenantId, tenantId, now - SKIP_ERROR_S, now - SKIP_RETRY_S) as { id: string; contact: string }[]

  for (const l of leads) {
    // re-read state each time so a pause or kill takes effect between sends
    if (!live()) return stop('paused')
    await d.keep?.()
    let id: string
    let context: string | null
    try {
      id = createDraft(db, tenantId, l.id, businessName)
      context = draftContext(db, tenantId, id)
      try { await polishDraft(db, tenantId, id, businessName, d) } catch { /* template stays */ }
    } catch (e) {
      // Recorded once per reason: a lead refused again for the same reason moves its skipped row's time instead of
      // adding a row (an hourly retry must not bury the sends and releases in the audit).
      const code = e instanceof OutreachError ? e.code : 'error'
      const last = db.prepare("SELECT id, detail FROM autopilot_audit WHERE tenant_id = ? AND lead_id = ? AND action = 'skipped' ORDER BY created_at DESC LIMIT 1").get(tenantId, l.id) as { id: string; detail: string | null } | undefined
      if (last && last.detail === code) db.prepare('UPDATE autopilot_audit SET created_at = ? WHERE id = ? AND tenant_id = ?').run(now, last.id, tenantId)
      else audit(db, tenantId, 'skipped', code, l.id)
      out.skipped++; continue
    }
    // The polish may change only the words: the offer, seller, sender settings or Gmail address changing across it hands
    // the draft to the user.
    const expected = draftAuthority(db, tenantId, id)
    if (!context || !expected || draftContext(db, tenantId, id) !== context) { release(id, l.id); continue }
    if (await deliver(id, l.id, 0, expected) === 'stop') return out
  }
  return out
}

export interface DrainResult { sent: number; held: number; skipped: number; stopped?: string }

// Scheduler drain of the first-touch backlog: drafts the autopilot itself held for a named reason, due now. A draft
// is sent only when every authority it was created under is still current: autopilot on, unpaused, consent current,
// warmup already cleared, the hold recorded under this consent version, and the offer inputs unchanged (changed words
// or offer invalidate the authority; the draft is skipped, never sent). Warmup-manual drafts and drafts with no hold
// record are never touched. Caps are re-checked at send time; an over-cap tenant is re-held, not sent.
export async function drainFirstTouch(db: Database.Database, tenantId: string, d: Deps & { flags?: Record<string, string | undefined> } = {}): Promise<DrainResult> {
  const out: DrainResult = { sent: 0, held: 0, skipped: 0 }
  const env = d.flags ?? process.env
  const now = d.now ?? Math.floor(Date.now() / 1000)
  const audit = (db2: Database.Database, t: string, a: string, dt?: string, l?: string, m?: string) => auditAt(db2, t, a, dt, l, m, now)
  const stop = (why: string): DrainResult => { out.stopped = why; return out }
  if (!autopilotAvailable(env)) return stop('not_available')
  const st = getState(db, tenantId)
  if (!st.enabled) return stop('off')
  if (st.paused) return stop('paused')
  if (!st.consent_current) return stop('consent_required')
  if (sentTotal(db, tenantId) < WARMUP_SENDS(env)) return stop('warmup') // first sends stay manually approved
  const rows = db.prepare(
    `SELECT id, lead_id, to_email, status, offer_hash FROM outreach_messages
     WHERE tenant_id = ? AND status IN ('draft','approved') AND hold_reason IN ('daily_cap','held_domain_cap','send_failed','reply_sync_stale')
       AND hold_policy = ? AND hold_until IS NOT NULL AND hold_until <= ?
     ORDER BY created_at LIMIT 10`,
  ).all(tenantId, CONSENT_VERSION, now) as { id: string; lead_id: string; to_email: string; status: string; offer_hash: string | null }[]
  for (const m of rows) {
    const cur = getState(db, tenantId)
    if (cur.paused || !cur.enabled || !autopilotAvailable(env)) return stop('paused')
    if (m.offer_hash === null || offerHashFor(db, tenantId, m.lead_id) !== m.offer_hash) {
      // The offer (or its readability) changed since the draft was created: the authority these words were prepared
      // under is gone. Never send; leave a clear skipped record.
      db.prepare("UPDATE outreach_messages SET status = 'skipped', error = 'offer_changed', hold_reason = NULL, hold_until = NULL WHERE id = ? AND tenant_id = ? AND status IN ('draft','approved')").run(m.id, tenantId)
      audit(db, tenantId, 'skipped', 'offer_changed', m.lead_id, m.id); out.skipped++; continue
    }
    const domain = m.to_email.split('@')[1]
    if (autoSent24h(db, tenantId, now) >= st.daily_cap) { setHold(db, tenantId, m.id, m.lead_id, 'daily_cap', dailyCapDueAt(db, tenantId, now)); out.held++; continue }
    if (domainSentRecently(db, tenantId, domain, now)) { setHold(db, tenantId, m.id, m.lead_id, 'held_domain_cap', domainCapDueAt(db, tenantId, domain, now)); out.held++; continue }
    if (isSuppressed(db, tenantId, m.to_email)) {
      db.prepare("UPDATE outreach_messages SET status = 'skipped', error = 'suppressed', hold_reason = NULL, hold_until = NULL WHERE id = ? AND tenant_id = ? AND status IN ('draft','approved')").run(m.id, tenantId)
      audit(db, tenantId, 'skipped', 'suppressed', m.lead_id, m.id); out.skipped++; continue
    }
    try {
      if (m.status === 'draft') approve(db, tenantId, m.id) // a released retry is already approved; approve() is draft-only
      const r = await sendMessage(db, tenantId, m.id, d)
      if (r === 'sent') { out.sent++; audit(db, tenantId, 'sent', undefined, m.lead_id, m.id) }
      else { audit(db, tenantId, 'uncertain', 'send outcome unknown', m.lead_id, m.id); pause(db, tenantId, 'uncertain_send'); return stop('uncertain_send') }
    } catch (e) {
      if (!(e instanceof OutreachError)) throw e // DB/runtime faults are scheduler failures, never retry-classified
      const code = e.code
      audit(db, tenantId, 'send_failed', code, m.lead_id, m.id)
      if (code === 'gmail_reconnect_needed' || code === 'gmail_not_connected') { pause(db, tenantId, code); return stop(code) }
      if (code === 'paused' || code === 'already_uncertain') return stop(code)
      if (holdSendFailure(db, tenantId, m.id, m.lead_id, code, now) === 'skipped') out.skipped++; else out.held++
    }
  }
  return out
}
