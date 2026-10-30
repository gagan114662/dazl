import { createHash, randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { gmailStatus } from '../gmail/oauth.ts'
import { createDraft, approve, getSettings, isSuppressed, OutreachError, sendMessage, suppress, type Deps } from './service.ts'
import { polishDraft } from './draft-llm.ts'
import { enrollAutoSequence } from './auto-sequence.ts'

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
const autoSent24h = (db: Database.Database, tenantId: string, now: number) => (db.prepare("SELECT count(*) AS n FROM autopilot_audit WHERE tenant_id = ? AND action = 'sent' AND created_at >= ?").get(tenantId, now - 86400) as { n: number }).n
const domainSentRecently = (db: Database.Database, tenantId: string, domain: string, now: number) =>
  !!db.prepare("SELECT 1 FROM outreach_messages WHERE tenant_id = ? AND status IN ('sent','sending','uncertain') AND to_email LIKE ? AND claimed_at >= ?").get(tenantId, `%@${domain}`, now - 7 * 86400)

export interface RunResult { sent: number; held: number; skipped: number; stopped?: string; enrolled?: number }

// What autopilot was allowed to send for this draft: its exact words and recipient, the sender identity and offer they
// carry, the Gmail account it goes out from, and the consent version. Recomputed before a held draft is sent; a different
// value hands it back to the user.
export function draftAuthority(db: Database.Database, tenantId: string, messageId: string): string | null {
  const m = db.prepare(`SELECT m.to_email, m.subject, m.body, j.offer, j.seller FROM outreach_messages m
    JOIN leads l ON l.id = m.lead_id JOIN scan_jobs j ON j.id = l.scan_job_id AND j.user_id = m.tenant_id
    WHERE m.id = ? AND m.tenant_id = ?`).get(messageId, tenantId) as { to_email: string; subject: string; body: string; offer: string | null; seller: string | null } | undefined
  if (!m) return null
  const s = getSettings(db, tenantId) as { sender_name?: string; postal_address?: string } | undefined
  return createHash('sha256').update(JSON.stringify([CONSENT_VERSION, m.to_email, m.subject, m.body, m.offer, m.seller, s?.sender_name ?? null, s?.postal_address ?? null, gmailSender(db, tenantId)])).digest('hex')
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

  // The gates and the send, for a draft autopilot made (new, or held earlier). 'stop' ends the pass, with out.stopped set.
  const deliver = async (id: string, leadId: string, attempts: number): Promise<'stop' | void> => {
    const msg = db.prepare('SELECT to_email, status FROM outreach_messages WHERE id = ? AND tenant_id = ?').get(id, tenantId) as { to_email: string; status: string }
    const to = msg.to_email
    // Warm-up drafts are the user's to approve: never sent by autopilot later, whatever happens to the caps.
    if (sentTotal(db, tenantId) < WARMUP_SENDS(env)) { out.held++; hold(id, leadId, 'warmup', null); audit(db, tenantId, 'held_warmup', 'needs your approval', leadId, id); return }
    if (autoSent24h(db, tenantId, now) >= st.daily_cap) {
      // Due again when the oldest autopilot send of the last 24 hours drops out of the window (inclusive at its edge).
      const oldest = (db.prepare("SELECT min(created_at) AS t FROM autopilot_audit WHERE tenant_id = ? AND action = 'sent' AND created_at >= ?").get(tenantId, now - 86400) as { t: number | null }).t ?? now
      out.held++; hold(id, leadId, 'daily_cap', oldest + 86400 + 1, attempts); audit(db, tenantId, 'daily_cap', `cap ${st.daily_cap}`, leadId, id); out.stopped = 'daily_cap'; return 'stop'
    }
    const domain = to.split('@')[1]
    if (domainSentRecently(db, tenantId, domain, now)) {
      const last = (db.prepare("SELECT max(claimed_at) AS t FROM outreach_messages WHERE tenant_id = ? AND status IN ('sent','sending','uncertain') AND to_email LIKE ?").get(tenantId, `%@${domain}`) as { t: number | null }).t ?? now
      out.held++; hold(id, leadId, 'domain_cap', last + 7 * 86400 + 1, attempts); audit(db, tenantId, 'held_domain_cap', 'one email per company per 7 days', leadId, id); return
    }
    if (isSuppressed(db, tenantId, to)) { out.skipped++; drop(id); audit(db, tenantId, 'skipped', 'suppressed', leadId, id); return }
    try {
      if (msg.status === 'draft') approve(db, tenantId, id)
      // Only from the Gmail account the authority was taken with: the send path refuses at commitment if it changed.
      const r = await sendMessage(db, tenantId, id, { ...d, expectSender: gmailSender(db, tenantId) ?? '' })
      drop(id)
      if (r === 'sent') {
        out.sent++; audit(db, tenantId, 'sent', undefined, leadId, id)
        // #414: under the account's automatic follow-up policy, the first touch is enrolled once in its cold sequence.
        // Enrollment sends nothing; a failure here never undoes or repeats the send.
        try { if (enrollAutoSequence(db, tenantId, id, gmailSender(db, tenantId) ?? '', businessName, now)) out.enrolled = (out.enrolled ?? 0) + 1 } catch (e) { audit(db, tenantId, 'enroll_failed', e instanceof Error ? e.message.slice(0, 60) : 'error', leadId, id) }
      }
      // An unknown outcome is never retried by autopilot: the message stays uncertain for the user.
      else { audit(db, tenantId, 'uncertain', 'send outcome unknown', leadId, id); pause(db, tenantId, 'uncertain_send'); out.stopped = 'uncertain_send'; return 'stop' }
    } catch (e) {
      const code = e instanceof OutreachError ? e.code : 'error'
      audit(db, tenantId, 'send_failed', code, leadId, id)
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
    if (draftAuthority(db, tenantId, w.message_id) !== w.authority) {
      backToUser(w.message_id); out.held++; audit(db, tenantId, 'released', 'changed since autopilot drafted it: yours to approve', w.lead_id, w.message_id); continue
    }
    if (await deliver(w.message_id, w.lead_id, w.attempts) === 'stop') return out
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
    try {
      id = createDraft(db, tenantId, l.id, businessName)
      try { await polishDraft(db, tenantId, id, businessName, d) } catch { /* template stays */ }
    } catch (e) {
      out.skipped++; audit(db, tenantId, 'skipped', e instanceof OutreachError ? e.code : 'error', l.id); continue
    }
    if (await deliver(id, l.id, 0) === 'stop') return out
  }
  return out
}
