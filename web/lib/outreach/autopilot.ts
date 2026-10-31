import { createHash, randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { gmailStatus } from '../gmail/oauth.ts'
import { createDraft, approve, getSettings, isSuppressed, OutreachError, sendMessage, suppress, type Deps } from './service.ts'
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
  db.prepare('UPDATE autopilot_settings SET enabled = 0 WHERE tenant_id = ?').run(tenantId)
  audit(db, tenantId, 'disabled')
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
// What counts against autopilot's caps: sends, sends in flight (reserved before the send path is entered) and sends whose
// outcome is unknown. A reservation is released only when the send path refused before anything left (known not sent).
const CAP_ACTIONS = "('sent','send_reserved','send_uncertain')"
// Autopilot sends counted in the last 24 hours (sent, reserved, or possibly sent), and the oldest of them.
const autoSent24h = (db: Database.Database, tenantId: string, now: number) => (db.prepare(`SELECT count(*) AS n FROM autopilot_audit WHERE tenant_id = ? AND action IN ${CAP_ACTIONS} AND created_at >= ?`).get(tenantId, now - 86400) as { n: number }).n
const oldestCounted = (db: Database.Database, tenantId: string, now: number) => (db.prepare(`SELECT min(created_at) AS t FROM autopilot_audit WHERE tenant_id = ? AND action IN ${CAP_ACTIONS} AND created_at >= ?`).get(tenantId, now - 86400) as { t: number | null }).t
// The same count as one send sees it at its own commitment: every send that went out or may have (whenever it was
// reserved), plus the slots reserved before its own (by created_at, then id: one fixed order). Slots reserved after it do not count
// against it, they count it against themselves, so two sends in flight never refuse each other: the one ahead in that
// order goes, the other is refused when the cap, as it is now, has no room for it. Either way the window never exceeds the cap.
const countedAhead = (db: Database.Database, tenantId: string, now: number, own: string) => (db.prepare(`SELECT count(*) AS n FROM autopilot_audit a WHERE a.tenant_id = ? AND a.action IN ${CAP_ACTIONS} AND a.created_at >= ? AND a.id <> ?
  AND (a.action <> 'send_reserved' OR (a.created_at, a.id) < (SELECT o.created_at, o.id FROM autopilot_audit o WHERE o.id = ?))`).get(tenantId, now - 86400, own, own) as { n: number }).n
// The last time this company was emailed (sent, sending or uncertain) or had an autopilot send reserved, if within 7 days.
// own: this send's own message and reservation, left out when the check runs at its own commitment.
const domainLastSent = (db: Database.Database, tenantId: string, domain: string, now: number, own = { reservation: '', message: '' }): number | null => {
  const m = (db.prepare("SELECT max(claimed_at) AS t FROM outreach_messages WHERE tenant_id = ? AND status IN ('sent','sending','uncertain') AND to_email LIKE ? AND claimed_at >= ? AND id <> ?").get(tenantId, `%@${domain}`, now - 7 * 86400, own.message) as { t: number | null }).t
  const r = (db.prepare(`SELECT max(created_at) AS t FROM autopilot_audit WHERE tenant_id = ? AND action IN ${CAP_ACTIONS} AND detail = ? AND created_at >= ? AND id <> ?`).get(tenantId, domain, now - 7 * 86400, own.reservation) as { t: number | null }).t
  return m === null && r === null ? null : Math.max(m ?? 0, r ?? 0)
}

export interface RunResult { sent: number; held: number; skipped: number; stopped?: string }

// What autopilot was allowed to send for this draft: its exact words and recipient, the sender identity and offer they
// carry, the Gmail account it goes out from, and the consent version. Recomputed before a held draft is sent; a different
// value hands it back to the user.
function authorityInputs(db: Database.Database, tenantId: string, messageId: string) {
  const m = db.prepare(`SELECT m.to_email, m.subject, m.body, j.offer, j.seller FROM outreach_messages m
    JOIN leads l ON l.id = m.lead_id JOIN scan_jobs j ON j.id = l.scan_job_id AND j.user_id = m.tenant_id
    WHERE m.id = ? AND m.tenant_id = ?`).get(messageId, tenantId) as { to_email: string; subject: string; body: string; offer: string | null; seller: string | null } | undefined
  if (!m) return null
  const s = getSettings(db, tenantId) as { sender_name?: string; postal_address?: string } | undefined
  return { ...m, sender_name: s?.sender_name ?? null, postal_address: s?.postal_address ?? null, gmail: gmailSender(db, tenantId) }
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
const TRANSIENT = new Set(['gmail_unavailable', 'gmail_rate_limited', 'daily_cap'])
const RETRY_MAX = 3
// The account must reconnect Gmail or resume: the work stays due and goes on the first pass after that.
const WAIT_FOR_USER = new Set(['gmail_reconnect_needed', 'gmail_not_connected', 'paused'])
// Autopilot's own authority ended while the send was in progress (turned off, operator flag off, consent no longer
// current, or its reserved slot gone): known not sent, the slot is released, and the draft stays held and unapproved
// until autopilot runs again under current authority.
const AUTHORITY_ENDED = new Set(['autopilot_off', 'autopilot_unavailable', 'consent_required', 'reservation_lost', 'authority_unreadable'])
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
export async function runAutopilot(db: Database.Database, tenantId: string, businessName: string, d: Deps & { flags?: Record<string, string | undefined> } = {}): Promise<RunResult> {
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
  const live = () => { const s2 = getState(db, tenantId); return !s2.paused && s2.enabled && autopilotAvailable(env) }

  const hold = (id: string, leadId: string, reason: string, nextAt: number | null, attempts = 0) => {
    const auth = draftAuthority(db, tenantId, id)
    if (!auth) return
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
  const release = (id: string, leadId: string) => { backToUser(id); out.held++; audit(db, tenantId, 'released', 'changed since autopilot drafted it: yours to approve', leadId, id) }
  const keepHeld = (id: string, leadId: string, code: string, attempts: number, nextAt: number = now) => {
    hold(id, leadId, code, nextAt, attempts)
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
  const deliver = async (id: string, leadId: string, attempts: number, expected: string): Promise<'stop' | void> => {
    // A draft polished (or a held one re-checked) across an await: autopilot may have been turned off meanwhile.
    const before = authority()
    if (before) { out.held++; if (before === 'paused') hold(id, leadId, before, now, attempts); else keepHeld(id, leadId, before, attempts); out.stopped = before; return 'stop' }
    if (draftAuthority(db, tenantId, id) !== expected) { release(id, leadId); return }
    const msg = db.prepare('SELECT to_email, status FROM outreach_messages WHERE id = ? AND tenant_id = ?').get(id, tenantId) as { to_email: string; status: string }
    const to = msg.to_email
    // Warm-up drafts are the user's to approve: never sent by autopilot later, whatever happens to the caps.
    if (sentTotal(db, tenantId) < WARMUP_SENDS(env)) { out.held++; hold(id, leadId, 'warmup', null); audit(db, tenantId, 'held_warmup', 'needs your approval', leadId, id); return }
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
      out.held++; hold(id, leadId, admit.held, admit.at, attempts)
      if (admit.held === 'domain_cap') { audit(db, tenantId, 'held_domain_cap', 'one email per company per 7 days', leadId, id); return }
      audit(db, tenantId, 'daily_cap', `cap ${admit.cap}`, leadId, id); out.stopped = 'daily_cap'; return 'stop'
    }
    const settle = (action: 'sent' | 'send_uncertain' | null) => action
      ? db.prepare('UPDATE autopilot_audit SET action = ? WHERE id = ? AND tenant_id = ?').run(action, admit.reservation, tenantId)
      : db.prepare("DELETE FROM autopilot_audit WHERE id = ? AND tenant_id = ? AND action = 'send_reserved'").run(admit.reservation, tenantId)
    try {
      if (msg.status === 'draft') approve(db, tenantId, id)
      // Only from the Gmail account the authority was taken with: the send path refuses at commitment if it changed.
      // authorize: re-read by the send path as its last check, after the token refresh, immediately before Gmail: autopilot's
      // own authority, the draft's fingerprint, this send's reservation, and the volume limits as they are now.
      // A read that fails there refuses the send (fail closed): no send goes on an authority nobody could read.
      const volumeNow = () => { const h = capHold(domain, { reservation: admit.reservation, message: id }); return h ? `volume_${h.held}` : null }
      const authorize = (): string | null => {
        try { return authority() ?? (draftAuthority(db, tenantId, id) !== expected ? AUTHORITY_CHANGED : null) ?? (db.prepare("SELECT 1 FROM autopilot_audit WHERE id = ? AND tenant_id = ? AND action = 'send_reserved'").get(admit.reservation, tenantId) ? null : 'reservation_lost') ?? volumeNow() }
        catch { return AUTHORITY_UNREADABLE }
      }
      const r = await sendMessage(db, tenantId, id, { ...d, expectSender: gmailSender(db, tenantId) ?? '', authorize })
      drop(id)
      // The reservation becomes the send's record ('sent', counted once) or stays counted as possibly sent.
      if (r === 'sent') { out.sent++; settle('sent') }
      // An unknown outcome is never retried by autopilot: the message stays uncertain for the user.
      else { settle('send_uncertain'); audit(db, tenantId, 'uncertain', 'send outcome unknown', leadId, id); pause(db, tenantId, 'uncertain_send'); out.stopped = 'uncertain_send'; return 'stop' }
    } catch (e) {
      const code = e instanceof OutreachError ? e.code : 'error'
      // The send path's refusals (OutreachError) come before anything is sent, so the reservation is released; anything
      // else may have happened after the bytes left, so it keeps counting.
      settle(e instanceof OutreachError ? null : 'send_uncertain')
      audit(db, tenantId, 'send_failed', code, leadId, id)
      // A volume limit refused it at commitment (the slot is released above): held until the limit has room, unapproved.
      const vol = VOLUME_AT_SEND.get(code)
      if (vol) { keepHeld(id, leadId, vol, attempts, capHold(domain)?.at ?? now); out.held++; if (vol === 'daily_cap') { out.stopped = vol; return 'stop' } return }
      if (AUTHORITY_ENDED.has(code)) { keepHeld(id, leadId, code, attempts); out.held++; out.stopped = code; return 'stop' }
      if (WAIT_FOR_USER.has(code)) { hold(id, leadId, code, now, attempts); if (code !== 'paused') pause(db, tenantId, code); out.held++; out.stopped = code; return 'stop' }
      if (TRANSIENT.has(code) && attempts + 1 < RETRY_MAX) { hold(id, leadId, code, now + 3600 * 2 ** attempts, attempts + 1); out.held++; return }
      // Any other refusal (a check now holds the lead or the address, the sending account changed, retries ran out):
      // the user decides.
      backToUser(id); out.held++
    }
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
    if (await deliver(w.message_id, w.lead_id, w.attempts, w.authority) === 'stop') return out
  }

  // 2. Verified leads with no message yet.
  const leads = db.prepare(
    `SELECT l.id, l.contact FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
     WHERE j.user_id = ? AND l.evidence_excerpt IS NOT NULL AND l.confidence >= ? AND l.contact IS NOT NULL AND l.quarantined_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM outreach_messages m WHERE m.tenant_id = ? AND m.lead_id = l.id)
     ORDER BY l.score DESC LIMIT 25`,
  ).all(tenantId, MIN_CONFIDENCE, tenantId) as { id: string; contact: string }[]

  for (const l of leads) {
    // re-read state each time so a pause or kill takes effect between sends
    if (!live()) return stop('paused')
    let id: string
    let context: string | null
    try {
      id = createDraft(db, tenantId, l.id, businessName)
      context = draftContext(db, tenantId, id)
      try { await polishDraft(db, tenantId, id, businessName, d) } catch { /* template stays */ }
    } catch (e) {
      out.skipped++; audit(db, tenantId, 'skipped', e instanceof OutreachError ? e.code : 'error', l.id); continue
    }
    // The polish may change only the words: the offer, seller, sender settings or Gmail address changing across it hands
    // the draft to the user.
    const expected = draftAuthority(db, tenantId, id)
    if (!context || !expected || draftContext(db, tenantId, id) !== context) { release(id, l.id); continue }
    if (await deliver(id, l.id, 0, expected) === 'stop') return out
  }
  return out
}
