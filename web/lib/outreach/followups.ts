import { accountSendCount, ACCOUNT_SEND_CAP, anyUncertainSend, tableExists } from './send-budget.ts'
import type Database from 'better-sqlite3'
import { buildMime, toBase64Url } from '../gmail/mime.ts'
import { getAccessToken, gmailSend, gmailStatus, type OAuthDeps } from '../gmail/oauth.ts'
import { auditAt, autopilotAvailable, getState, pause } from './autopilot.ts'
import { hasConsent } from './ledger.ts'
import { composeBody, getSettings, isSuppressed, leadHeld, recipientAllowed, unsubToken, type Deps } from './service.ts'
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
export const followupsEnabled = (db: Database.Database, tenantId: string) =>
  (db.prepare('SELECT followups_enabled AS f FROM autopilot_settings WHERE tenant_id = ?').get(tenantId) as { f: number } | undefined)?.f === 1

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
    if (t.last_followup_at && t.last_lead_reply_at > t.last_followup_at) { db.prepare("UPDATE followup_threads SET stopped = 'replied_again' WHERE tenant_id = ? AND thread_id = ?").run(tenantId, t.thread_id); skip('replied again, left for you'); continue }
    if (now - t.last_activity_at < GAPS_DAYS[t.followups_sent] * 86400) continue
    if (isSuppressed(db, tenantId, t.to_email)) { db.prepare("UPDATE followup_threads SET stopped = 'suppressed' WHERE tenant_id = ? AND thread_id = ?").run(tenantId, t.thread_id); skip('suppressed'); continue }
    if (!hasConsent(db, tenantId, t.to_email, 'email', 'followup', now)) { skip('no valid consent'); continue }
    const sentToday = (db.prepare("SELECT count(*) AS n FROM autopilot_audit WHERE tenant_id = ? AND action IN ('sent','followup_sent') AND created_at >= ?").get(tenantId, now - 86400) as { n: number }).n
    if (accountSendCount(db,tenantId,now) >= Math.min(ACCOUNT_SEND_CAP,cur.daily_cap)) return stop('daily_cap')

    // at most once: the claim row is unique per thread and step
    const claim = db.prepare("INSERT OR IGNORE INTO followup_messages (tenant_id, thread_id, step, status, created_at) VALUES (?, ?, ?, 'sending', ?)").run(tenantId, t.thread_id, t.followups_sent, now)
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
      const raw = toBase64Url(buildMime({ fromName: settings.sender_name, fromEmail: acct.email, to: t.to_email, subject: orig.subject.startsWith('Re:') ? orig.subject : `Re: ${orig.subject}`, body: composeBody((await llmFollowupText(db, tenantId, t.followups_sent, lead, businessName, settings.booking_url, d)) ?? followupText(t.followups_sent, lead, businessName, settings.booking_url), settings, unsubUrl), messageId: `dazl.f${t.followups_sent}.${orig.id}@${acct.email.split('@')[1]}`, unsubscribeUrl: unsubUrl, date: new Date(now * 1000), inReplyTo: t.root_message_id }))
      if (leadHeld(db,tenantId,t.lead_id) || !recipientAllowed(db,tenantId,t.to_email)) {
        db.prepare('DELETE FROM followup_messages WHERE tenant_id = ? AND thread_id = ? AND step = ?').run(tenantId,t.thread_id,t.followups_sent)
        skip(leadHeld(db,tenantId,t.lead_id) ? 'lead_ungraded' : 'personal_email'); continue
      }
      const r = await (d.sendFn ?? gmailSend)(token, raw, d.fetchImpl, t.thread_id)
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
export interface FollowupThreadView {
  thread_id: string
  company: string
  name: string
  to_email: string
  last_lead_reply_at: number | null
  followups_sent: number
  next_due_at: number | null
  stopped: string | null
}
export interface FollowupOverview {
  enabled: boolean
  account: string | null
  threads: FollowupThreadView[]
  sent: { thread_id: string; company: string; to_email: string; step: number; status: string; created_at: number }[]
}

export function followupOverview(db: Database.Database, tenantId: string, now = Math.floor(Date.now() / 1000)): FollowupOverview {
  const rows = db.prepare(
    `SELECT t.thread_id, t.to_email, t.last_activity_at, t.last_lead_reply_at, t.followups_sent, t.stopped,
            COALESCE(l.company, '') AS company, COALESCE(l.name, '') AS name
     FROM followup_threads t LEFT JOIN leads l ON l.id = t.lead_id
     WHERE t.tenant_id = ? ORDER BY t.last_activity_at DESC LIMIT 100`,
  ).all(tenantId) as { thread_id: string; to_email: string; last_activity_at: number; last_lead_reply_at: number | null; followups_sent: number; stopped: string | null; company: string; name: string }[]
  const threads = rows.map(r => ({
    thread_id: r.thread_id,
    company: r.company,
    name: r.name,
    to_email: r.to_email,
    last_lead_reply_at: r.last_lead_reply_at,
    followups_sent: r.followups_sent,
    stopped: r.stopped,
    // The next follow-up is due GAPS_DAYS[sent] days after the last activity; nothing is due for
    // stopped or exhausted sequences, or threads with no interested reply yet.
    next_due_at: r.stopped || r.followups_sent >= MAX_FOLLOWUPS || r.last_lead_reply_at === null
      ? null
      : r.last_activity_at + (GAPS_DAYS[r.followups_sent] ?? GAPS_DAYS[GAPS_DAYS.length - 1]) * 86400,
  }))
  const sent = db.prepare(
    `SELECT m.thread_id, m.step, m.status, m.created_at, t.to_email, COALESCE(l.company, '') AS company
     FROM followup_messages m JOIN followup_threads t ON t.tenant_id = m.tenant_id AND t.thread_id = m.thread_id
     LEFT JOIN leads l ON l.id = t.lead_id
     WHERE m.tenant_id = ? ORDER BY m.created_at DESC LIMIT 100`,
  ).all(tenantId) as { thread_id: string; company: string; to_email: string; step: number; status: string; created_at: number }[]
  void now
  const acct = gmailStatus(db, tenantId)
  return { enabled: followupsEnabled(db, tenantId), account: acct?.status === 'active' ? acct.email : null, threads, sent }
}

// What the follow-ups page should ask for when automatic follow-ups are not running.
// 'none'    - everything is on, nothing to ask.
// 'switch'  - Gmail is connected; only the follow-ups switch is off. Asking the user
//             to "Connect Gmail" here contradicts the "Gmail connected as ..." line.
// 'connect' - Gmail is not connected; the switch is moot until it is.
export type FollowupAsk = 'none' | 'switch' | 'connect'
export function followupAsk(o: Pick<FollowupOverview, 'enabled' | 'account'>): FollowupAsk {
  if (o.enabled) return 'none'
  return o.account ? 'switch' : 'connect'
}
