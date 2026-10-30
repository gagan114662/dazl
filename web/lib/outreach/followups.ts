import {contactPurposeRestricted} from './contact-purpose-db.ts'
import {currentnessHeld} from './currentness.ts'
import { accountSendCount, ACCOUNT_SEND_CAP, anyUncertainSend, tableExists } from './send-budget.ts'
import type Database from 'better-sqlite3'
import type { Db, Param } from '../db/client.ts'
import { isMissingSchema } from '../scan/play-offer-text.ts'
import { norm } from './store.ts'
import { buildMime, toBase64Url } from '../gmail/mime.ts'
import { confirmedSendResult, getAccessToken, gmailSend, gmailStatus, readGmailStatus, type OAuthDeps } from '../gmail/oauth.ts'
import { auditAt, autopilotAvailable, CONSENT_VERSION, DEFAULT_DAILY, getState, pause } from './autopilot.ts'
import { hasConsent } from './ledger.ts'
import { composeBody, getSettings, isSuppressed, domainReviewStatus, leadEvidenceEligible, leadHeld, recipientAllowed, unsubToken, type Deps } from './service.ts'
import { llmFollowupText } from './draft-llm.ts'
import { getMasterKey } from '../secrets.ts'

// Follow-ups only for people who replied with interest (a ledger row) and only fill silence.
// At most 2, 3 and 5 days after the last activity in the thread. A newer reply from them stops the
// sequence for the user to handle. Every autopilot guardrail still applies.
export const MAX_FOLLOWUPS = 2
export const GAPS_DAYS = [3, 5]

export function setFollowups(db: Database.Database, tenantId: string, on: boolean): void {
  db.prepare('UPDATE autopilot_settings SET followups_enabled = ? WHERE tenant_id = ?').run(on ? 1 : 0, tenantId)
  auditAt(db, tenantId, on ? 'followups_on' : 'followups_off')
}
const FOLLOWUPS_ENABLED_SQL = 'SELECT followups_enabled AS f FROM autopilot_settings WHERE tenant_id = ?'
export const followupsEnabled = (db: Database.Database, tenantId: string) =>
  (db.prepare(FOLLOWUPS_ENABLED_SQL).get(tenantId) as { f: number } | undefined)?.f === 1

export function followupText(step: number, lead: { company: string; name: string; signal: string; source_url: string }, businessName: string, bookingUrl?: string | null): string {
  const who = lead.name ? lead.name.split(' ')[0] : 'there'
  const fact = `${lead.signal} (${lead.source_url})`
  const book = bookingUrl ? `\n\nYou can grab a time here: ${bookingUrl}` : ''
  return step === 0
    ? `Hi ${who},\n\nThanks for getting back to me. Following up in case it got buried: ${fact}\n\nI run ${businessName}. Would a short call this week make sense?${book}\n\nThanks,`
    : `Hi ${who},\n\nLast note from me on this: ${fact}${book}\n\nIf it isn't a priority right now, no problem, and I won't follow up again.\n\nThanks,`
}

export interface FollowResult { sent: number; skipped: number; stopped?: string }

export async function runFollowups(db: Database.Database, tenantId: string, businessName: string, d: Deps & { flags?: Record<string, string | undefined> } = {}): Promise<FollowResult> {
  const out: FollowResult = { sent: 0, skipped: 0 }
  const flags = d.flags ?? process.env
  const now = d.now ?? Math.floor(Date.now() / 1000)
  const stop = (w: string): FollowResult => { out.stopped = w; return out }
  if (!autopilotAvailable(flags)) return stop('not_available')
  const st = getState(db, tenantId)
  if (!st.enabled || st.paused || !st.consent_current) return stop('autopilot_off')
  if (!followupsEnabled(db, tenantId)) return stop('followups_off')
  const settings = getSettings(db, tenantId)
  const acct = gmailStatus(db, tenantId)
  if (anyUncertainSend(db, tenantId)) return stop('uncertain_send')
  if (!settings || acct?.status !== 'active') return stop('gmail_or_identity')
  if (db.prepare("SELECT 1 FROM outreach_messages WHERE tenant_id = ? AND status = 'uncertain'").get(tenantId) || db.prepare("SELECT 1 FROM followup_messages WHERE tenant_id = ? AND status IN ('uncertain','sending') AND created_at < ?").get(tenantId, now - 600)) { pause(db, tenantId, 'uncertain_send'); return stop('uncertain_send') }

  const threads = db.prepare('SELECT thread_id, lead_id, to_email, root_message_id, last_activity_at, last_lead_reply_at, followups_sent, last_followup_at FROM followup_threads WHERE tenant_id = ? AND stopped IS NULL AND followups_sent < ? AND last_lead_reply_at IS NOT NULL').all(tenantId, MAX_FOLLOWUPS) as { thread_id: string; lead_id: string; to_email: string; root_message_id: string; last_activity_at: number; last_lead_reply_at: number; followups_sent: number; last_followup_at: number | null }[]
  for (const t of threads) {
    const cur = getState(db, tenantId)
    if (cur.paused || !cur.enabled || !autopilotAvailable(flags) || !followupsEnabled(db, tenantId)) return stop('paused')
    if (tableExists(db, 'sequences') && db.prepare("SELECT 1 FROM sequences WHERE tenant_id = ? AND lead_id = ?").get(tenantId,t.lead_id)) continue // sequence enrollment owns this thread; never layer warm automation on it
    const skip = (why: string) => { out.skipped++; auditAt(db, tenantId, 'followup_skipped', why, t.lead_id, undefined, now) }
    if (leadHeld(db,tenantId,t.lead_id) || !recipientAllowed(db,tenantId,t.to_email)) { skip(leadHeld(db,tenantId,t.lead_id) ? 'lead_ungraded' : 'personal_email'); continue }
    // A withdrawn lead confirmation stops the thread for good before any warm follow-up
    // quotes the revoked signal; re-confirming the lead does not resurrect a stopped thread.
    if (contactPurposeRestricted(db,tenantId,t.lead_id,t.to_email)) { skip('not_sales_contact'); continue }
    if (currentnessHeld(db,tenantId,t.lead_id)) { skip('lead_currentness_unconfirmed'); continue }
    if (!leadEvidenceEligible(db,tenantId,t.lead_id)) { db.prepare("UPDATE followup_threads SET stopped = 'evidence_withdrawn' WHERE tenant_id = ? AND thread_id = ?").run(tenantId, t.thread_id); skip('evidence_withdrawn'); continue }
    if (t.last_followup_at && t.last_lead_reply_at > t.last_followup_at) { db.prepare("UPDATE followup_threads SET stopped = 'replied_again' WHERE tenant_id = ? AND thread_id = ?").run(tenantId, t.thread_id); skip('replied again, left for you'); continue }
    if (now - t.last_activity_at < GAPS_DAYS[t.followups_sent] * 86400) continue
    if (isSuppressed(db, tenantId, t.to_email)) { db.prepare("UPDATE followup_threads SET stopped = 'suppressed' WHERE tenant_id = ? AND thread_id = ?").run(tenantId, t.thread_id); skip('suppressed'); continue }
    if (!hasConsent(db, tenantId, t.to_email, 'email', 'followup', now)) { skip('no valid consent'); continue }
    const sentToday = (db.prepare("SELECT count(*) AS n FROM autopilot_audit WHERE tenant_id = ? AND action IN ('sent','followup_sent') AND created_at >= ?").get(tenantId, now - 86400) as { n: number }).n
    if (accountSendCount(db,tenantId,now) >= Math.min(ACCOUNT_SEND_CAP,cur.daily_cap)) return stop('daily_cap')

    // at most once: the claim row is unique per thread and step
    // The identity check and the claim are one write transaction (the lock the review action takes). A held thread is stopped for good,
    // like a withdrawn lead confirmation: re-confirming the website does not restart it.
    // An unreadable review state is a retryable fault: skip this round without stopping the thread.
    const claim = db.transaction((): { changes: number } | 'required' | 'unreadable' | 'quarantined' => {
      const st = domainReviewStatus(db, tenantId, t.lead_id, t.to_email)
      if (st !== 'ok') return st
      return db.prepare("INSERT OR IGNORE INTO followup_messages (tenant_id, thread_id, step, status, created_at) VALUES (?, ?, ?, 'sending', ?)").run(tenantId, t.thread_id, t.followups_sent, now)
    }).immediate()
    if (claim === 'unreadable') { skip('review_unreadable'); continue }
    // A quarantined lead stops its thread for good, like an unconfirmed website (releasing it does not restart it).
    if (claim === 'quarantined') { db.prepare("UPDATE followup_threads SET stopped = 'lead_quarantined' WHERE tenant_id = ? AND thread_id = ? AND stopped IS NULL").run(tenantId, t.thread_id); skip('lead_quarantined'); continue }
    if (claim === 'required') { db.prepare("UPDATE followup_threads SET stopped = 'domain_unconfirmed' WHERE tenant_id = ? AND thread_id = ? AND stopped IS NULL").run(tenantId, t.thread_id); skip('domain_unconfirmed'); continue }
    if (claim.changes !== 1) { skip('already claimed'); continue }
    if (accountSendCount(db,tenantId,now) > Math.min(ACCOUNT_SEND_CAP,cur.daily_cap)) { db.prepare('DELETE FROM followup_messages WHERE tenant_id = ? AND thread_id = ? AND step = ?').run(tenantId,t.thread_id,t.followups_sent); return stop('daily_cap') }
    const lead = db.prepare('SELECT l.company, l.name, l.signal, l.source_url FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?').get(t.lead_id, tenantId) as { company: string; name: string; signal: string; source_url: string } | undefined
    const orig = db.prepare('SELECT id, subject FROM outreach_messages WHERE tenant_id = ? AND lead_id = ?').get(tenantId, t.lead_id) as { id: string; subject: string } | undefined
    if (!lead || !orig) { db.prepare('DELETE FROM followup_messages WHERE tenant_id = ? AND thread_id = ? AND step = ?').run(tenantId, t.thread_id, t.followups_sent); skip('lead missing'); continue }
    const master = d.master ?? getMasterKey()
    const unsubUrl = `${(d.baseUrl ?? process.env.PUBLIC_BASE_URL ?? 'https://dazl.ai').replace(/\/$/, '')}/api/unsubscribe?t=${unsubToken(orig.id, master)}`
    let token: string
    try { token = await getAccessToken(db, tenantId, d as OAuthDeps) } catch { db.prepare('DELETE FROM followup_messages WHERE tenant_id = ? AND thread_id = ? AND step = ?').run(tenantId, t.thread_id, t.followups_sent); pause(db, tenantId, 'gmail_reconnect_needed'); return stop('gmail_unavailable') }
    try {
      const raw = toBase64Url(buildMime({ fromName: settings.sender_name, fromEmail: acct.email, to: t.to_email, subject: orig.subject.startsWith('Re:') ? orig.subject : `Re: ${orig.subject}`, body: composeBody((await llmFollowupText(db, tenantId, t.followups_sent, { ...lead, lead_id: t.lead_id }, businessName, settings.booking_url, d)) ?? followupText(t.followups_sent, lead, businessName, settings.booking_url), settings, unsubUrl), messageId: `dazl.f${t.followups_sent}.${orig.id}@${acct.email.split('@')[1]}`, unsubscribeUrl: unsubUrl, date: new Date(now * 1000), inReplyTo: t.root_message_id }))
      if (leadHeld(db,tenantId,t.lead_id) || !recipientAllowed(db,tenantId,t.to_email)) {
        db.prepare('DELETE FROM followup_messages WHERE tenant_id = ? AND thread_id = ? AND step = ?').run(tenantId,t.thread_id,t.followups_sent)
        skip(leadHeld(db,tenantId,t.lead_id) ? 'lead_ungraded' : 'personal_email'); continue
      }
      // Re-checked after the token await: withdrawal during the await deletes the claim
      // row (nothing stuck in 'sending') and stops the thread, never sends.
      if (contactPurposeRestricted(db,tenantId,t.lead_id,t.to_email)) {
        db.prepare('DELETE FROM followup_messages WHERE tenant_id = ? AND thread_id = ? AND step = ?').run(tenantId,t.thread_id,t.followups_sent)
        skip('not_sales_contact'); continue
      }
      if (currentnessHeld(db,tenantId,t.lead_id)) {
        db.prepare('DELETE FROM followup_messages WHERE tenant_id = ? AND thread_id = ? AND step = ?').run(tenantId,t.thread_id,t.followups_sent)
        skip('lead_currentness_unconfirmed'); continue
      }
      if (!leadEvidenceEligible(db,tenantId,t.lead_id)) {
        db.prepare('DELETE FROM followup_messages WHERE tenant_id = ? AND thread_id = ? AND step = ?').run(tenantId,t.thread_id,t.followups_sent)
        db.prepare("UPDATE followup_threads SET stopped = 'evidence_withdrawn' WHERE tenant_id = ? AND thread_id = ?").run(tenantId, t.thread_id)
        skip('evidence_withdrawn'); continue
      }
      const stAfter = domainReviewStatus(db,tenantId,t.lead_id,t.to_email)
      if (stAfter !== 'ok') {
        db.prepare('DELETE FROM followup_messages WHERE tenant_id = ? AND thread_id = ? AND step = ?').run(tenantId,t.thread_id,t.followups_sent)
        if (stAfter === 'required' || stAfter === 'quarantined') db.prepare("UPDATE followup_threads SET stopped = ? WHERE tenant_id = ? AND thread_id = ? AND stopped IS NULL").run(stAfter === 'quarantined' ? 'lead_quarantined' : 'domain_unconfirmed', tenantId, t.thread_id)
        skip(stAfter === 'required' ? 'domain_unconfirmed' : stAfter === 'quarantined' ? 'lead_quarantined' : 'review_unreadable'); continue
      }
      const r = confirmedSendResult(await (d.sendFn ?? gmailSend)(token, raw, d.fetchImpl, t.thread_id))
      db.prepare("UPDATE followup_messages SET status = 'sent', gmail_id = ? WHERE tenant_id = ? AND thread_id = ? AND step = ?").run(r.id, tenantId, t.thread_id, t.followups_sent)
      db.prepare('UPDATE followup_threads SET followups_sent = followups_sent + 1, last_followup_at = ?, last_activity_at = ? WHERE tenant_id = ? AND thread_id = ?').run(now, now, tenantId, t.thread_id)
      auditAt(db, tenantId, 'followup_sent', `step ${t.followups_sent + 1}`, t.lead_id, orig.id, now); out.sent++
    } catch {
      db.prepare("UPDATE followup_messages SET status = 'uncertain' WHERE tenant_id = ? AND thread_id = ? AND step = ?").run(tenantId, t.thread_id, t.followups_sent)
      auditAt(db, tenantId, 'uncertain', 'follow-up outcome unknown', t.lead_id, orig.id, now); pause(db, tenantId, 'uncertain_send'); return stop('uncertain_send')
    }
  }
  return out
}

// Read model for the Follow-ups page: every sequence with its schedule state, plus the
// follow-ups already sent. Read-only; nothing here starts or stops a sequence.
// Why the runner (runFollowups) would send nothing right now, checked in its own order. Account-wide holds stop every
// thread; thread holds stop one; the daily cap holds every thread that is already due. Lead-level checks the runner
// makes at send time (lead review, website, currentness, contact purpose, evidence) are not repeated here: a date shown
// can still be skipped then, never the reverse.
export type FollowupHold = 'not_available' | 'autopilot_off' | 'autopilot_paused' | 'consent_outdated' | 'followups_off' | 'uncertain_send' | 'gmail_or_identity'
export type ThreadHold = 'sequence' | 'suppressed' | 'no_consent' | 'replied_again' | 'daily_cap'
export interface FollowupThreadView {
  thread_id: string
  company: string
  name: string
  to_email: string
  last_lead_reply_at: number | null
  followups_sent: number
  // when the gap schedule says the next follow-up would be due (configuration), and when it actually will be: null
  // whenever something holds it (hold says what)
  scheduled_at: number | null
  next_due_at: number | null
  hold: FollowupHold | ThreadHold | null
  stopped: string | null
}
export interface FollowupOverview {
  enabled: boolean
  account: string | null
  hold: FollowupHold | null
  threads: FollowupThreadView[]
  sent: { thread_id: string; company: string; to_email: string; step: number; status: string; created_at: number }[]
}

// The follow-ups page, on the Db layer (SQLite or Postgres). Read-only and tenant-scoped: every row is the tenant's own
// (followup_threads.tenant_id, followup_messages.tenant_id), and the lead join adds a name and company only from a lead
// of the tenant's own scan (OWN_LEAD), so a thread that named another tenant's lead shows no company rather than theirs.
const OWN_LEAD = 'EXISTS (SELECT 1 FROM scan_jobs j WHERE j.id = l.scan_job_id AND j.user_id = t.tenant_id)'
// A table an older database does not have yet holds nothing; any other read error is not "no hold" and throws.
async function exists(db: Db, sql: string, args: Param[]): Promise<boolean> {
  try { return !!(await db.get(sql, args)) } catch (e) { if (isMissingSchema(e)) return false; throw e }
}
// A follow-up claim the runner left 'sending' (or 'uncertain') longer than this pauses the account (runFollowups).
const STALE_CLAIM_SECONDS = 600
async function accountHold(db: Db, tenantId: string, flags: Record<string, string | undefined>, now: number): Promise<FollowupHold | null> {
  if (!autopilotAvailable(flags)) return 'not_available'
  const st = await db.get<{ enabled: number; paused: number; consent_version: string | null; followups_enabled: number }>('SELECT enabled, paused, consent_version, followups_enabled FROM autopilot_settings WHERE tenant_id = ?', [tenantId])
  if (!st || Number(st.enabled) !== 1) return 'autopilot_off'
  if (Number(st.paused) === 1) return 'autopilot_paused'
  if (st.consent_version !== CONSENT_VERSION) return 'consent_outdated'
  if (Number(st.followups_enabled) !== 1) return 'followups_off'
  for (const [table, status] of [['outreach_messages', 'uncertain'], ['followup_messages', 'uncertain'], ['sequence_steps', 'uncertain'], ['reopen_messages', 'approved']])
    if (await exists(db, `SELECT 1 FROM ${table} WHERE tenant_id = ? AND status = ?`, [tenantId, status])) return 'uncertain_send'
  const acct = await readGmailStatus(db, tenantId)
  if (acct?.status !== 'active' || !(await exists(db, 'SELECT 1 FROM outreach_settings WHERE tenant_id = ?', [tenantId]))) return 'gmail_or_identity'
  // the runner's own stale-claim check (same boundary): a send it started and never finished pauses the account
  if (await exists(db, "SELECT 1 FROM followup_messages WHERE tenant_id = ? AND status IN ('uncertain','sending') AND created_at < ?", [tenantId, now - STALE_CLAIM_SECONDS])) return 'uncertain_send'
  return null
}
// The runner's rolling 24-hour budget (send-budget.ts accountSendCount) on the Db layer: true when it would stop at the
// daily cap now. A table an older database does not have yet counts nothing.
async function capReached(db: Db, tenantId: string, now: number): Promise<boolean> {
  const since = now - 86400
  const count = async (sql: string) => { try { return Number((await db.get<{ n: number }>(sql, [tenantId, since]))?.n ?? 0) } catch (e) { if (isMissingSchema(e)) return 0; throw e } }
  const n = await count("SELECT count(*) AS n FROM outreach_messages WHERE tenant_id = ? AND status IN ('sent','sending','uncertain') AND COALESCE(claimed_at,sent_at,created_at) >= ?")
    + await count("SELECT count(*) AS n FROM followup_messages WHERE tenant_id = ? AND status IN ('sent','sending','uncertain') AND created_at >= ?")
    + await count("SELECT count(*) AS n FROM sequence_steps WHERE tenant_id = ? AND step > 1 AND status IN ('sent','sending','uncertain') AND COALESCE(claimed_at,sent_at,created_at) >= ?")
    + await count("SELECT count(*) AS n FROM reopen_messages WHERE tenant_id = ? AND status IN ('sent','approved') AND COALESCE(sent_at,created_at) >= ?")
  const cap = Number((await db.get<{ c: number }>('SELECT daily_cap AS c FROM autopilot_settings WHERE tenant_id = ?', [tenantId]))?.c ?? DEFAULT_DAILY)
  return n >= Math.min(ACCOUNT_SEND_CAP, cap)
}
async function threadHold(db: Db, tenantId: string, t: { lead_id: string; to_email: string; last_lead_reply_at: number | null; last_followup_at: number | null }, now: number): Promise<ThreadHold | null> {
  if (await exists(db, 'SELECT 1 FROM sequences WHERE tenant_id = ? AND lead_id = ?', [tenantId, t.lead_id])) return 'sequence'
  // a reply after our last follow-up: the runner stops the thread and leaves it for the user
  if (t.last_followup_at && Number(t.last_lead_reply_at) > Number(t.last_followup_at)) return 'replied_again'
  if (await exists(db, 'SELECT 1 FROM suppressions WHERE tenant_id = ? AND email = ?', [tenantId, norm(t.to_email)])) return 'suppressed'
  if (!(await exists(db, "SELECT 1 FROM consent_ledger WHERE tenant_id = ? AND contact = ? AND channel = 'email' AND scope = 'followup' AND revoked_at IS NULL AND expires_at > ?", [tenantId, norm(t.to_email), now]))) return 'no_consent'
  return null
}

export async function followupOverview(db: Db, tenantId: string, opts: { flags?: Record<string, string | undefined>; now?: number } = {}): Promise<FollowupOverview> {
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const hold = await accountHold(db, tenantId, opts.flags ?? process.env, now)
  const capFull = hold ? false : await capReached(db, tenantId, now)
  const rows = await db.all<{ thread_id: string; lead_id: string; to_email: string; last_activity_at: number; last_lead_reply_at: number | null; last_followup_at: number | null; followups_sent: number; stopped: string | null; company: string; name: string }>(
    `SELECT t.thread_id, t.lead_id, t.to_email, t.last_activity_at, t.last_lead_reply_at, t.last_followup_at, t.followups_sent, t.stopped,
            COALESCE(l.company, '') AS company, COALESCE(l.name, '') AS name
     FROM followup_threads t LEFT JOIN leads l ON l.id = t.lead_id AND ${OWN_LEAD}
     WHERE t.tenant_id = ? ORDER BY t.last_activity_at DESC, t.thread_id LIMIT 100`, [tenantId])
  const threads: FollowupThreadView[] = []
  for (const r of rows) {
    // By the gap schedule the next follow-up is due GAPS_DAYS[sent] days after the last activity; nothing is scheduled
    // for stopped or exhausted sequences, or threads with no interested reply yet.
    const scheduled = r.stopped || Number(r.followups_sent) >= MAX_FOLLOWUPS || r.last_lead_reply_at === null
      ? null
      : Number(r.last_activity_at) + (GAPS_DAYS[Number(r.followups_sent)] ?? GAPS_DAYS[GAPS_DAYS.length - 1]) * 86400
    // A date is promised only when the runner would actually send: no account-wide hold and none on this thread. The
    // cap holds a thread that is due now; a later date stays, since the rolling window may have room by then.
    const h = scheduled === null ? null : hold ?? await threadHold(db, tenantId, r, now) ?? (capFull && scheduled <= now ? 'daily_cap' : null)
    threads.push({ thread_id: r.thread_id, company: r.company, name: r.name, to_email: r.to_email, last_lead_reply_at: r.last_lead_reply_at,
      followups_sent: Number(r.followups_sent), stopped: r.stopped, scheduled_at: scheduled, next_due_at: h ? null : scheduled, hold: h })
  }
  const sent = await db.all<{ thread_id: string; company: string; to_email: string; step: number; status: string; created_at: number }>(
    `SELECT m.thread_id, m.step, m.status, m.created_at, t.to_email, COALESCE(l.company, '') AS company
     FROM followup_messages m JOIN followup_threads t ON t.tenant_id = m.tenant_id AND t.thread_id = m.thread_id
     LEFT JOIN leads l ON l.id = t.lead_id AND ${OWN_LEAD}
     WHERE m.tenant_id = ? ORDER BY m.created_at DESC, m.thread_id, m.step DESC LIMIT 100`, [tenantId])
  const acct = await readGmailStatus(db, tenantId)
  const enabled = Number((await db.get<{ f: number }>(FOLLOWUPS_ENABLED_SQL, [tenantId]))?.f) === 1
  return { enabled, account: acct?.status === 'active' ? acct.email : null, hold, threads, sent }
}

// What the follow-ups page should ask for (lib/outreach/followup-ask.ts, client-safe).
export { followupAsk, type FollowupAsk } from './followup-ask.ts'
