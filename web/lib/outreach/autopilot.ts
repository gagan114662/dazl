import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { gmailStatus } from '../gmail/oauth.ts'
import { createDraft, approve, getSettings, isSuppressed, OutreachError, sendMessage, suppress, type Deps } from './service.ts'
import { polishDraft, type LlmDeps } from './draft-llm.ts'
import { calibratedStop, claimIssuesFor, launchGate, launchProviders, migrateLaunchPolicy, outsidePolicy, withdrawLaunchPolicy, type LaunchGate, type SpendStop } from './launch-policy.ts'
import { providers as defaultProviders } from '../llm/provider.ts'
import { captureError } from '../ops/errors.ts'

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
  migrateLaunchPolicy(db) // a calibrated launch's accepted policy (lib/outreach/launch-policy.ts, #405)
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
// The one pause autopilot takes on its own account for the launch (launch_not_calibrated: an accepted policy that is not a
// launch) is lifted by the two events that end that state: a passing preflight, or the tenant withdrawing the policy. Any
// other pause reason is the tenant's to resume.
export function liftLaunchPause(db: Database.Database, tenantId: string): void {
  if (getState(db, tenantId).pause_reason === 'launch_not_calibrated') { db.prepare("UPDATE autopilot_settings SET paused = 0, pause_reason = NULL WHERE tenant_id = ? AND pause_reason = 'launch_not_calibrated'").run(tenantId); audit(db, tenantId, 'resumed', 'launch_not_calibrated') }
}
// The tenant withdraws their launch policy: the row goes, the launch with it, the launch pause is lifted, and they are back
// on the hand-approval warmup (the sample drafts stay theirs). Returns false when there was nothing to withdraw.
export function withdrawLaunch(db: Database.Database, tenantId: string): boolean {
  const gone = withdrawLaunchPolicy(db, tenantId)
  if (gone) { audit(db, tenantId, 'launch_withdrawn'); liftLaunchPause(db, tenantId) }
  return gone
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
// Autopilot's sends in the last 24h, for the daily and rollout caps: its 'sent' audit rows, plus every OTHER autopilot
// message it has claimed for sending ('claimed' audit row, written in the cap reservation below) that is still live
// (sending, uncertain or sent), each message counted once. A claimed message the service refused and put back to
// 'approved' (or that autopilot released to draft) is not live: it never left, so it holds no slot. Hand sends have no
// claim row and are not counted
// (the account-wide cap in the send service counts those). A send in flight in another pass therefore already counts,
// so two passes cannot both see room for the last send; the reservation itself is taken in one transaction with this
// count, so neither can two passes reserve the same slot. (#448 adds a committed-reservation counter for the daily cap;
// when it lands the two are unified in that merge.)
const autoCount24h = (db: Database.Database, tenantId: string, now: number, exceptMessageId: string | null) => (db.prepare(
  `SELECT (SELECT count(*) FROM autopilot_audit WHERE tenant_id = ? AND action = 'sent' AND created_at >= ? AND message_id IS NULL)
        + (SELECT count(DISTINCT a.message_id) FROM autopilot_audit a LEFT JOIN outreach_messages m ON m.id = a.message_id
             WHERE a.tenant_id = ? AND a.created_at >= ? AND a.message_id IS NOT NULL AND a.message_id <> ?
               AND (a.action = 'sent' OR (a.action = 'claimed' AND m.status IN ('sending', 'uncertain', 'sent')))) AS n`,
).get(tenantId, now - 86400, tenantId, now - 86400, exceptMessageId ?? '') as { n: number }).n
const domainSentRecently = (db: Database.Database, tenantId: string, domain: string, now: number) =>
  !!db.prepare("SELECT 1 FROM outreach_messages WHERE tenant_id = ? AND status IN ('sent','sending','uncertain') AND to_email LIKE ? AND claimed_at >= ?").get(tenantId, `%@${domain}`, now - 7 * 86400)

export interface RunResult { sent: number; held: number; skipped: number; stopped?: string }

type Lead = { id: string; contact: string; source_url: string | null; play: string }
// Every stop autopilot must respect in order to send ONE lead right now, each re-read from the store at the moment of
// asking, never carried across an await: the operator flag and kill switch; the tenant's switches (off, paused, consent);
// an uncertain send anywhere; the launch (a run that started calibrated must still be the SAME acceptance from the same
// mailbox, and a warmup run must not have become calibrated under it); under a calibrated launch the policy's own stops
// (a reply, the bounce rate, an unreadable stop store), its scope for this recipient and its claim authority on the
// final words; and the daily cap (the tenant's, and the rollout's). This is the final-handoff contract (#405): it runs
// before drafting, after drafting (the model await) and, as the send service's sendAuthority, at the claim and again
// after the Gmail token refresh immediately before the bytes leave. Null means send. A check that cannot be read (any
// store it needs unreadable, the launch store included) is a stop: stop_check_unavailable, never "no launch" or "no cap".
type Stop = 'not_available' | 'off' | 'paused' | 'consent_required' | 'uncertain_send' | 'launch_policy_changed' | 'launch_not_calibrated' | 'reply_received' | 'bounce_rate' | 'stop_check_unavailable' | 'not_in_audience' | 'excluded' | 'claims' | 'daily_cap'
function stopNow(db: Database.Database, tenantId: string, env: Record<string, string | undefined>, now: number, started: LaunchGate, l: Lead, messageId: string | null): Stop | null {
  try { return stopNowUnguarded(db, tenantId, env, now, started, l, messageId) } catch { return 'stop_check_unavailable' }
}
function stopNowUnguarded(db: Database.Database, tenantId: string, env: Record<string, string | undefined>, now: number, started: LaunchGate, l: Lead, messageId: string | null): Stop | null {
  if (!autopilotAvailable(env)) return 'not_available'
  const st = getState(db, tenantId)
  if (!st.enabled) return 'off'
  if (st.paused) return 'paused'
  if (!st.consent_current) return 'consent_required'
  if (db.prepare("SELECT 1 FROM outreach_messages WHERE tenant_id = ? AND status = 'uncertain'").get(tenantId)) return 'uncertain_send'
  const g = gmailStatus(db, tenantId)
  const gate = launchGate(db, tenantId, g?.status === 'active' ? g.email : null, now)
  if (gate.calibrated !== started.calibrated || (gate.calibrated && started.calibrated && gate.acceptanceId !== started.acceptanceId)) return 'launch_policy_changed'
  // a policy the tenant accepted that is not a launch right now (not yet calibrated, re-accepted, stale version, invalid,
  // other mailbox): nothing is sent until a preflight passes (a pause, lifted by that preflight); never the warmup's rules
  if (!gate.calibrated && gate.accepted) return 'launch_not_calibrated'
  if (gate.calibrated) {
    const halt = calibratedStop(db, tenantId, gate)
    if (halt) return halt
    const m = messageId ? db.prepare('SELECT to_email, subject, body FROM outreach_messages WHERE id = ? AND tenant_id = ?').get(messageId, tenantId) as { to_email: string; subject: string; body: string } | undefined : undefined
    const outside = outsidePolicy(gate.policy, l.play, m?.to_email ?? l.contact)
    if (outside) return outside
    if (m && claimIssuesFor(gate.policy, `${m.subject}\n${m.body}`, l.source_url ? [l.source_url] : []).length) return 'claims'
  }
  const cap = gate.calibrated ? Math.min(st.daily_cap, gate.cap) : st.daily_cap
  if (autoCount24h(db, tenantId, now, messageId) >= cap) return 'daily_cap'
  return null
}
// What a stop means for the run: the policy's own stops and an uncertain send pause autopilot; the launch changing is
// reported as policy_changed; the rest stop this run under their own name.
// launch_not_calibrated pauses too: the tenant's last word is a policy that is not a launch, so nothing goes out until a
// preflight passes; that passing calibration lifts this one pause itself (runCalibration), so the tenant is not stranded.
const PAUSES: ReadonlySet<string> = new Set(['reply_received', 'bounce_rate', 'stop_check_unavailable', 'uncertain_send', 'already_uncertain', 'gmail_reconnect_needed', 'gmail_not_connected', 'launch_not_calibrated'])
const runOutcome = (code: string) => code === 'launch_policy_changed' ? 'policy_changed' : code === 'already_uncertain' ? 'uncertain_send' : code
// Codes that mean autopilot's OWN authority to send lapsed (every stopNow code, however it surfaced). A message autopilot
// approved under that authority goes back to being the tenant's draft, never left approved with autopilot's hash on it.
const AUTHORITY_CODES: ReadonlySet<string> = new Set(['not_available', 'off', 'paused', 'consent_required', 'uncertain_send', 'already_uncertain', 'launch_policy_changed', 'launch_not_calibrated', 'reply_received', 'bounce_rate', 'stop_check_unavailable', 'daily_cap'])

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

  // Under a calibrated launch the candidates are the policy's audience only (its plays, minus its excluded addresses and
  // domains), selected in the query itself: a skipped lead writes no row, so if the 25 best unmessaged leads were out of
  // the policy they would come back every tick and the audience would never be reached. The per-lead check below still
  // runs on every candidate (the policy is re-read each time). An unreadable launch store here is a stop, not a warmup run.
  const mailbox = () => { const g = gmailStatus(db, tenantId); return g?.status === 'active' ? g.email : null }
  let scope: { sql: string; args: (string | number)[] } = { sql: '', args: [] }
  try {
    const g0 = launchGate(db, tenantId, mailbox(), now)
    if (!g0.calibrated && g0.accepted) { pause(db, tenantId, 'launch_not_calibrated'); audit(db, tenantId, 'stopped', 'launch_not_calibrated'); return stop('launch_not_calibrated') }
    if (g0.calibrated) {
      const { audience, exclusions } = g0.policy
      const like = (d: string) => '%@' + d.replace(/[\\%_]/g, c => '\\' + c)
      scope = {
        sql: ` AND j.id IN (${audience.playIds.map(() => '?').join(', ')})`
          + (exclusions.emails.length ? ` AND lower(l.contact) NOT IN (${exclusions.emails.map(() => '?').join(', ')})` : '')
          + exclusions.domains.map(() => " AND lower(l.contact) NOT LIKE ? ESCAPE '\\'").join(''),
        args: [...audience.playIds, ...exclusions.emails, ...exclusions.domains.map(like)],
      }
    }
  } catch { pause(db, tenantId, 'stop_check_unavailable'); return stop('stop_check_unavailable') }
  const leads = db.prepare(
    `SELECT l.id, l.contact, l.source_url, j.id AS play FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
     WHERE j.user_id = ? AND l.evidence_excerpt IS NOT NULL AND l.confidence >= ? AND l.contact IS NOT NULL AND l.quarantined_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM outreach_messages m WHERE m.tenant_id = ? AND m.lead_id = l.id)${scope.sql}
     ORDER BY l.score DESC LIMIT 25`,
  ).all(tenantId, MIN_CONFIDENCE, tenantId, ...scope.args) as Lead[]
  // A calibrated launch (#405): an accepted, current policy launched by a passing preflight, from the policy's own
  // mailbox. It replaces only the hand-approval warmup; it narrows every send to the policy and adds its stops and
  // rollout cap. Without one, the warmup, consent, pause, uncertain-send, per-domain and suppression rules are as
  // before; what changed for every run is that each stop (the daily cap included) is re-read before drafting, after
  // drafting and at the send boundary, so a cap reached before drafting writes no draft, and one reached at the boundary
  // releases the message to the tenant and ends the run (previously the cap was checked once, after drafting, and
  // ended the run leaving the draft held).
  // A stop ends the run. With a message already drafted it is held, and when the stop is autopilot's own authority
  // lapsing, the message goes back to a draft for the tenant (its approval, if any, was autopilot's). The stop may be
  // that a store is unreadable, so each step stands on its own: release the message first, pause second, record last;
  // a step that fails is not allowed to leave the message approved or the run thrown.
  const attempt = (f: () => void) => { try { f() } catch (e) { captureError(e, { source: 'worker', where: 'autopilot:ended', tenantId }) } } // an unreadable store is itself the stop; the run still ends with the reason, and the failed step is recorded
  const ended = (code: string, leadId: string, id?: string): RunResult => {
    if (id) {
      out.held++
      // 'sending' too: the claim is autopilot's own and the send call has returned, so a claim the service could not
      // release itself (its store failing on the release) is released here instead of waiting for the stale reaper
      if (AUTHORITY_CODES.has(code)) attempt(() => db.prepare("UPDATE outreach_messages SET status = 'draft', approved_hash = NULL, claimed_at = NULL, error = ? WHERE id = ? AND tenant_id = ? AND status IN ('draft','approved','sending')").run(code, id, tenantId))
    }
    if (PAUSES.has(code)) attempt(() => pause(db, tenantId, runOutcome(code)))
    if (id) attempt(() => audit(db, tenantId, `held_${runOutcome(code)}`, code === 'launch_policy_changed' ? 'the launch policy changed' : code, leadId, id))
    else attempt(() => audit(db, tenantId, 'stopped', runOutcome(code), leadId)) // nothing drafted yet: the lead is picked up again next run
    return stop(runOutcome(code))
  }

  for (const l of leads) {
    // re-read every stop before each lead, so a pause, a kill, a stop or a changed launch takes effect between sends.
    // The launch store being unreadable is a stop, never "no launch" (that would fall back to the warmup's wider rules).
    let gate: LaunchGate
    try { gate = launchGate(db, tenantId, mailbox(), now) } catch { return ended('stop_check_unavailable', l.id) }
    const before = stopNow(db, tenantId, env, now, gate, l, null)
    if (before === 'not_in_audience' || before === 'excluded') { out.skipped++; audit(db, tenantId, 'skipped', before, l.id); continue }
    if (before) return ended(before, l.id)
    let id: string
    try {
      id = createDraft(db, tenantId, l.id, businessName)
      // under a calibrated launch every model call reserves its worst case against the launch's spend cap first
      let refused: SpendStop | null = null
      const pd = gate.calibrated ? { ...d, providers: launchProviders((d as LlmDeps).providers ?? defaultProviders, db, tenantId, gate.launchedAt, gate.policy.spendCapUsd, now, why => { refused = why }) } : d
      try { await polishDraft(db, tenantId, id, businessName, pd) } catch { /* template stays */ }
      if (refused) { audit(db, tenantId, 'held_spend', refused, l.id, id); pause(db, tenantId, refused); return { ...out, held: out.held + 1, stopped: refused } }
    } catch (e) {
      out.skipped++; audit(db, tenantId, 'skipped', e instanceof OutreachError ? e.code : 'error', l.id); continue
    }
    // Drafting awaited a model: every stop again, on the final words. The accepted policy's claim authority on those words
    // (a price, an unlisted link) holds this draft for the tenant and goes on; any other stop ends the run.
    const after = stopNow(db, tenantId, env, now, gate, l, id)
    if (after === 'claims') { out.held++; audit(db, tenantId, 'held_claims', 'outside the launch policy', l.id, id); continue }
    if (after === 'not_in_audience' || after === 'excluded') return ended('launch_policy_changed', l.id, id)
    if (after) return ended(after, l.id, id)
    const to = (db.prepare('SELECT to_email FROM outreach_messages WHERE id = ?').get(id) as { to_email: string }).to_email
    if (!gate.calibrated && sentTotal(db, tenantId) < WARMUP_SENDS(env)) { out.held++; audit(db, tenantId, 'held_warmup', 'needs your approval', l.id, id); continue }
    const domain = to.split('@')[1]
    if (domainSentRecently(db, tenantId, domain, now)) { out.held++; audit(db, tenantId, 'held_domain_cap', 'one email per company per 7 days', l.id, id); continue }
    if (isSuppressed(db, tenantId, to)) { out.skipped++; audit(db, tenantId, 'skipped', 'suppressed', l.id, id); continue }
    // The cap reservation: in ONE transaction, every stop is re-read (the cap counting every other live autopilot claim)
    // and this message is recorded as claimed, so no two passes can take the same last slot, whatever order they drafted
    // or claim in. A refusal here ends the run like any other stop and the message stays the tenant's draft.
    const reserved = db.transaction(() => { const c = stopNow(db, tenantId, env, now, gate, l, id); if (!c) audit(db, tenantId, 'claimed', undefined, l.id, id); return c }).immediate()
    if (reserved) return ended(reserved === 'not_in_audience' || reserved === 'excluded' || reserved === 'claims' ? 'launch_policy_changed' : reserved, l.id, id)
    // The send service runs the same stops as its sendAuthority: at its claim, and again after its token refresh
    // immediately before Gmail. Scope or claim authority failing there means the launch changed under the send.
    const sendAuthority = () => {
      const c = stopNow(db, tenantId, env, now, gate, l, id)
      return c === 'not_in_audience' || c === 'excluded' || c === 'claims' ? 'launch_policy_changed' : c
    }
    try {
      approve(db, tenantId, id)
      const r = await sendMessage(db, tenantId, id, { ...d, sendAuthority })
      if (r === 'sent') { out.sent++; audit(db, tenantId, 'sent', undefined, l.id, id) }
      else { audit(db, tenantId, 'uncertain', 'send outcome unknown', l.id, id); pause(db, tenantId, 'uncertain_send'); return stop('uncertain_send') }
    } catch (e) {
      // anything but the service's own refusal code (a store the service could not read, an unexpected fault) is a
      // stop: autopilot does not carry on past a send whose outcome it cannot name
      const code = e instanceof OutreachError ? e.code : 'stop_check_unavailable'
      attempt(() => audit(db, tenantId, 'send_failed', code, l.id, id))
      // a stop surfaced at the send boundary (the service's own final checks or autopilot's sendAuthority): same outcome as
      // anywhere else, the message released back to the tenant when it was autopilot's authority that lapsed
      if (AUTHORITY_CODES.has(code) || PAUSES.has(code)) return ended(code, l.id, id)
      out.held++
    }
  }
  return out
}
