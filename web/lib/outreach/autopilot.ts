import { createHash, randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { gmailStatus } from '../gmail/oauth.ts'
import { createDraft, approve, getSettings, isSuppressed, OutreachError, playOfferRow, sendMessage, suppress, type Deps } from './service.ts'
import { readTenantOffer } from './play-memory.ts'
import { draftOffer } from '../scan/play-offer-text.ts'
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

// First-touch backlog holds. A hold records why the draft waits, when it may next be tried, the consent version the
// hold was recorded under and the offer the draft's words were created for. The scheduler drain acts only on holds it
// can name; warmup (manual-approval) drafts and pre-existing drafts with no hold record are never auto-sent.
const TRANSIENT_RETRY_S = 900
const MAX_SEND_RETRIES = 3
export const HOLD_REASONS = ['warmup_manual', 'daily_cap', 'held_domain_cap', 'send_failed'] as const

// The offer inputs a first-touch draft is created under, exactly as createDraftInner resolves them. A null means the
// offer could not be read: such a draft is never drained, since its authority cannot be re-verified.
function offerHashFor(db: Database.Database, tenantId: string, leadId: string): string | null {
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
function domainCapDueAt(db: Database.Database, tenantId: string, domain: string, now: number): number {
  const t = (db.prepare("SELECT MAX(claimed_at) AS t FROM outreach_messages WHERE tenant_id = ? AND status IN ('sent','sending','uncertain') AND to_email LIKE ? AND claimed_at >= ?").get(tenantId, `%@${domain}`, now - 7 * 86400) as { t: number | null }).t
  return (t ?? now) + 7 * 86400
}

// Classify a thrown send: only a generic provider failure ('error') is transient and known-not-sent (an
// accepted-but-unconfirmed send is returned as 'uncertain', never thrown). Transient failures get a bounded backoff
// retry; every named policy refusal is permanent, so the draft is skipped instead of stranded forever.
function holdSendFailure(db: Database.Database, tenantId: string, msgId: string, leadId: string, code: string, now: number): 'held' | 'skipped' {
  const tries = (db.prepare('SELECT attempts FROM outreach_messages WHERE id = ? AND tenant_id = ?').get(msgId, tenantId) as { attempts: number } | undefined)?.attempts ?? 0
  if (code === 'error' && tries < MAX_SEND_RETRIES) { setHold(db, tenantId, msgId, leadId, 'send_failed', now + TRANSIENT_RETRY_S * (tries + 1)); return 'held' }
  const why = code === 'error' ? 'retry_exhausted' : code
  db.prepare("UPDATE outreach_messages SET status = 'skipped', error = ?, hold_reason = NULL, hold_until = NULL WHERE id = ? AND tenant_id = ? AND status IN ('draft','approved')").run(why.slice(0, 200), msgId, tenantId)
  auditAt(db, tenantId, 'skipped', why, leadId, msgId, now)
  return 'skipped'
}

export interface RunResult { sent: number; held: number; skipped: number; stopped?: string }

// One pass over this tenant's verified leads that have no message yet. Safe to call repeatedly.
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

  // Recipient eligibility is judged by createDraft's single policy stack (published address from the cited page OR the
  // company's own crawled contact page, purpose, identity review, suppression), never by WHERE the contact was stored.
  // The prefilter therefore admits a lead whose own contact is absent or not an email when its sitecrawl recorded a
  // published email; createDraft picks that address with the same checks a manual draft passes, and every ineligible
  // route (wrong purpose, unconfirmed domain, suppressed, personal, undeliverable) is still refused there.
  const leads = db.prepare(
    `SELECT l.id, l.contact FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
     WHERE j.user_id = ? AND l.evidence_excerpt IS NOT NULL AND l.confidence >= ? AND l.quarantined_at IS NULL
       AND (l.contact IS NOT NULL OR EXISTS (SELECT 1 FROM lead_enrichments e WHERE e.lead_id = l.id AND e.tenant_id = ? AND e.connector = 'sitecrawl' AND e.kind = 'email'))
       AND NOT EXISTS (SELECT 1 FROM outreach_messages m WHERE m.tenant_id = ? AND m.lead_id = l.id)
     ORDER BY l.score DESC LIMIT 25`,
  ).all(tenantId, MIN_CONFIDENCE, tenantId, tenantId) as { id: string; contact: string }[]

  for (const l of leads) {
    // re-read state each time so a pause or kill takes effect between sends
    if (getState(db, tenantId).paused || !autopilotAvailable(env) || !getState(db, tenantId).enabled) return stop('paused')
    let id: string
    try {
      id = createDraft(db, tenantId, l.id, businessName)
      try { await polishDraft(db, tenantId, id, businessName, d) } catch { /* template stays */ }
    } catch (e) {
      out.skipped++; audit(db, tenantId, 'skipped', e instanceof OutreachError ? e.code : 'error', l.id); continue
    }
    const to = (db.prepare('SELECT to_email FROM outreach_messages WHERE id = ?').get(id) as { to_email: string }).to_email
    if (sentTotal(db, tenantId) < WARMUP_SENDS(env)) { setHold(db, tenantId, id, l.id, 'warmup_manual', null); out.held++; audit(db, tenantId, 'held_warmup', 'needs your approval', l.id, id); continue }
    if (autoSent24h(db, tenantId, now) >= st.daily_cap) { setHold(db, tenantId, id, l.id, 'daily_cap', dailyCapDueAt(db, tenantId, now)); audit(db, tenantId, 'daily_cap', `cap ${st.daily_cap}`, l.id, id); return { ...out, held: out.held + 1, stopped: 'daily_cap' } }
    const domain = to.split('@')[1]
    if (domainSentRecently(db, tenantId, domain, now)) { setHold(db, tenantId, id, l.id, 'held_domain_cap', domainCapDueAt(db, tenantId, domain, now)); out.held++; audit(db, tenantId, 'held_domain_cap', 'one email per company per 7 days', l.id, id); continue }
    if (isSuppressed(db, tenantId, to)) { out.skipped++; audit(db, tenantId, 'skipped', 'suppressed', l.id, id); continue }
    try {
      approve(db, tenantId, id)
      const r = await sendMessage(db, tenantId, id, d)
      if (r === 'sent') { out.sent++; audit(db, tenantId, 'sent', undefined, l.id, id) }
      else { audit(db, tenantId, 'uncertain', 'send outcome unknown', l.id, id); pause(db, tenantId, 'uncertain_send'); return stop('uncertain_send') }
    } catch (e) {
      const code = e instanceof OutreachError ? e.code : 'error'
      audit(db, tenantId, 'send_failed', code, l.id, id)
      if (code === 'gmail_reconnect_needed' || code === 'gmail_not_connected') { pause(db, tenantId, code); return stop(code) }
      if (code === 'paused' || code === 'already_uncertain') return stop(code)
      if (holdSendFailure(db, tenantId, id, l.id, code, now) === 'skipped') out.skipped++; else out.held++
    }
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
    `SELECT id, lead_id, to_email, offer_hash FROM outreach_messages
     WHERE tenant_id = ? AND status IN ('draft','approved') AND hold_reason IN ('daily_cap','held_domain_cap','send_failed')
       AND hold_policy = ? AND hold_until IS NOT NULL AND hold_until <= ?
     ORDER BY created_at LIMIT 10`,
  ).all(tenantId, CONSENT_VERSION, now) as { id: string; lead_id: string; to_email: string; offer_hash: string | null }[]
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
      approve(db, tenantId, m.id)
      const r = await sendMessage(db, tenantId, m.id, d)
      if (r === 'sent') { out.sent++; audit(db, tenantId, 'sent', undefined, m.lead_id, m.id) }
      else { audit(db, tenantId, 'uncertain', 'send outcome unknown', m.lead_id, m.id); pause(db, tenantId, 'uncertain_send'); return stop('uncertain_send') }
    } catch (e) {
      const code = e instanceof OutreachError ? e.code : 'error'
      audit(db, tenantId, 'send_failed', code, m.lead_id, m.id)
      if (code === 'gmail_reconnect_needed' || code === 'gmail_not_connected') { pause(db, tenantId, code); return stop(code) }
      if (code === 'paused' || code === 'already_uncertain') return stop(code)
      if (holdSendFailure(db, tenantId, m.id, m.lead_id, code, now) === 'skipped') out.skipped++; else out.held++
    }
  }
  return out
}
