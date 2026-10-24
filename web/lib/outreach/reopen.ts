// Warm again: re-engagement for threads where a lead replied with interest, then went
// quiet 30-90 days ago. DRAFT-ONLY by design (approve-before-send): this module creates
// and sends only through explicit user actions on the Follow-ups page. Autopilot never
// touches reopens. One re-open per thread, ever (primary key). Suppression is checked
// at draft time and again at send time.
import type Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { buildMime, toBase64Url } from '../gmail/mime.ts'
import { getAccessToken, gmailSend, gmailStatus, type OAuthDeps } from '../gmail/oauth.ts'
import { getMasterKey } from '../secrets.ts'
import { contactPurposeRestricted } from './contact-purpose-db.ts'
import { currentnessHeld } from './currentness.ts'
import { accountSendCount, anyUncertainSend, tableExists } from './send-budget.ts'
import { composeBody, getSettings, isSuppressed, leadHeld, recipientAllowed, leadEvidenceEligible, domainReviewHeld, domainHoldCode, OutreachError, unsubToken, DAILY_CAP, SENDING_STALE_S, type Deps } from './service.ts'

export const WARM_MIN_DAYS = 30
export const WARM_MAX_DAYS = 90

export function migrateReopen(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reopen_messages (
      tenant_id  TEXT NOT NULL,
      thread_id  TEXT NOT NULL,
      lead_id    TEXT NOT NULL,
      to_email   TEXT NOT NULL,
      body       TEXT NOT NULL CHECK (length(body) BETWEEN 20 AND 3000),
      status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','sent','skipped')),
      gmail_id   TEXT,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      sent_at    INTEGER,
      PRIMARY KEY (tenant_id, thread_id)
    );
  `)
}

interface WarmRow { thread_id: string; lead_id: string; to_email: string; root_message_id: string; last_lead_reply_at: number; company: string; name: string; last_class: string | null }
export interface WarmThread { thread_id: string; company: string; name: string; to_email: string; last_reply_at: number; reply_excerpt: string; reopen: { status: string; body: string } | null }

// Threads that qualify right now: last lead reply 30-90 days old, sequence not stopped,
// latest reply not an opt-out or a no, address not suppressed, no terminal stage, and no
// re-open created yet (one per thread, ever).
export function warmAgain(db: Database.Database, tenantId: string, now = Math.floor(Date.now() / 1000)): WarmThread[] {
  migrateReopen(db)
  const rows = db.prepare(
    `SELECT t.thread_id, t.lead_id, t.to_email, t.root_message_id, t.last_lead_reply_at,
            COALESCE(l.company, '') AS company, COALESCE(l.name, '') AS name, COALESCE(l.stage, '') AS stage,
            (SELECT classification FROM inbound_messages i WHERE i.tenant_id = t.tenant_id AND i.thread_id = t.thread_id ORDER BY received_at DESC LIMIT 1) AS last_class
     FROM followup_threads t LEFT JOIN leads l ON l.id = t.lead_id
     WHERE t.tenant_id = ? AND t.stopped IS NULL AND t.last_lead_reply_at IS NOT NULL
       AND t.last_lead_reply_at BETWEEN ? AND ?
       AND NOT EXISTS (SELECT 1 FROM reopen_messages r WHERE r.tenant_id = t.tenant_id AND r.thread_id = t.thread_id)`,
  ).all(tenantId, now - WARM_MAX_DAYS * 86400, now - WARM_MIN_DAYS * 86400) as (WarmRow & { stage: string })[]
  const out: WarmThread[] = []
  for (const r of rows) {
    if (r.last_class === 'opt_out' || r.last_class === 'negative') continue
    if (r.stage === 'booked_call') continue
    if (isSuppressed(db, tenantId, r.to_email)) continue
    const excerpt = (db.prepare('SELECT excerpt FROM inbound_messages WHERE tenant_id = ? AND thread_id = ? ORDER BY received_at DESC LIMIT 1').get(tenantId, r.thread_id) as { excerpt: string } | undefined)?.excerpt ?? ''
    out.push({ thread_id: r.thread_id, company: r.company, name: r.name, to_email: r.to_email, last_reply_at: r.last_lead_reply_at, reply_excerpt: excerpt, reopen: null })
  }
  return out
}

export function listReopens(db: Database.Database, tenantId: string): WarmThread[] {
  migrateReopen(db)
  const rows = db.prepare(
    `SELECT r.thread_id, r.to_email, r.body, r.status, t.last_lead_reply_at, COALESCE(l.company, '') AS company, COALESCE(l.name, '') AS name
     FROM reopen_messages r JOIN followup_threads t ON t.tenant_id = r.tenant_id AND t.thread_id = r.thread_id
     LEFT JOIN leads l ON l.id = r.lead_id WHERE r.tenant_id = ? ORDER BY r.created_at DESC LIMIT 50`,
  ).all(tenantId) as { thread_id: string; to_email: string; body: string; status: string; last_lead_reply_at: number | null; company: string; name: string }[]
  return rows.map(r => ({ thread_id: r.thread_id, company: r.company, name: r.name, to_email: r.to_email, last_reply_at: r.last_lead_reply_at ?? 0, reply_excerpt: '', reopen: { status: r.status, body: r.body } }))
}

export function reopenText(lead: { company: string; name: string; signal: string; source_url: string }, replyExcerpt: string, businessName: string): string {
  const who = lead.name ? lead.name.split(' ')[0] : 'there'
  const said = replyExcerpt ? `\n\nBack then you wrote: "${replyExcerpt.slice(0, 180)}"` : ''
  return `Hi ${who},\n\nYou replied to my note about ${lead.company || 'your team'} a while back (${lead.signal}) and we left it there.${said}\n\nStill happy to walk you through how ${businessName} could help if the timing is better now - a short call is all it takes.\n\nThanks,`
}

function qualify(db: Database.Database, tenantId: string, threadId: string): WarmRow {
  const r = db.prepare('SELECT thread_id, lead_id, to_email, root_message_id, last_lead_reply_at FROM followup_threads WHERE tenant_id = ? AND thread_id = ?').get(tenantId, threadId) as WarmRow | undefined
  if (!r) throw new OutreachError('not_found')
  return r
}

export function createReopenDraft(db: Database.Database, tenantId: string, threadId: string, businessName: string): void {
  const t = qualify(db, tenantId, threadId)
  if (leadHeld(db,tenantId,t.lead_id)) throw new OutreachError('lead_ungraded')
  if (isSuppressed(db, tenantId, t.to_email)) throw new OutreachError('suppressed')
  const lead = db.prepare('SELECT company, name, signal, source_url FROM leads WHERE id = ?').get(t.lead_id) as { company: string; name: string; signal: string; source_url: string } | undefined
  if (!lead) throw new OutreachError('lead_missing')
  const excerpt = (db.prepare('SELECT excerpt FROM inbound_messages WHERE tenant_id = ? AND thread_id = ? ORDER BY received_at DESC LIMIT 1').get(tenantId, threadId) as { excerpt: string } | undefined)?.excerpt ?? ''
  const r = db.prepare('INSERT OR IGNORE INTO reopen_messages (tenant_id, thread_id, lead_id, to_email, body) VALUES (?, ?, ?, ?, ?)').run(tenantId, threadId, t.lead_id, t.to_email, reopenText(lead, excerpt, businessName))
  if (r.changes !== 1) throw new OutreachError('already_created')
}

const getReopen = (db: Database.Database, tenantId: string, threadId: string) =>
  db.prepare('SELECT * FROM reopen_messages WHERE tenant_id = ? AND thread_id = ?').get(tenantId, threadId) as { thread_id: string; lead_id: string; to_email: string; body: string; status: string } | undefined

export function editReopen(db: Database.Database, tenantId: string, threadId: string, body: string): void {
  const r = getReopen(db, tenantId, threadId)
  if (!r) throw new OutreachError('not_found')
  if (r.status !== 'draft') throw new OutreachError('not_editable')
  const b = body.trim()
  if (b.length < 20 || b.length > 3000) throw new OutreachError('bad_body')
  // Guarded write: a claim taken by a send (here or in another process) after the read above must win.
  const w = db.prepare("UPDATE reopen_messages SET body = ? WHERE tenant_id = ? AND thread_id = ? AND status = 'draft'").run(b, tenantId, threadId)
  if (w.changes !== 1) throw new OutreachError('not_editable')
}

export function skipReopen(db: Database.Database, tenantId: string, threadId: string): void {
  const r = getReopen(db, tenantId, threadId)
  if (!r) throw new OutreachError('not_found')
  if (r.status === 'sent' || r.status === 'skipped') throw new OutreachError('final')
  if (r.status === 'approved') throw new OutreachError('send_uncertain')
  const w = db.prepare("UPDATE reopen_messages SET status = 'skipped' WHERE tenant_id = ? AND thread_id = ? AND status = 'draft'").run(tenantId, threadId)
  if (w.changes !== 1) {
    const now = getReopen(db, tenantId, threadId)?.status
    throw new OutreachError(now === 'approved' ? 'send_uncertain' : 'final')
  }
}

// The user reviewed the draft in the UI and pressed send. Suppression is re-checked here.
// Same stop as sendMessage: any autopilot pause (paused_by_user, bounces, uncertain_send, gmail_*) holds every send.
function accountPaused(db: Database.Database, tenantId: string): boolean {
  return tableExists(db, 'autopilot_settings') && !!(db.prepare('SELECT paused FROM autopilot_settings WHERE tenant_id = ?').get(tenantId) as { paused: number } | undefined)?.paused
}
// The same lead-level gates as the first-email send (sendMessage) and the follow-up sender. A re-open has no
// test-fixture exemption. Checked before any Gmail work and again after the token await, before the claim.
function leadGates(db: Database.Database, tenantId: string, r: { lead_id: string; to_email: string }): void {
  if (contactPurposeRestricted(db, tenantId, r.lead_id, r.to_email)) throw new OutreachError('not_sales_contact')
  if (currentnessHeld(db, tenantId, r.lead_id)) throw new OutreachError('lead_currentness_unconfirmed')
  if (!leadEvidenceEligible(db, tenantId, r.lead_id)) throw new OutreachError('lead_evidence_withdrawn')
  if (domainReviewHeld(db, tenantId, r.lead_id, r.to_email)) throw new OutreachError(domainHoldCode(db, tenantId, r.lead_id, r.to_email))
}
export async function sendReopen(db: Database.Database, tenantId: string, threadId: string, d: Deps & { now?: number } = {}): Promise<void> {
  const r = getReopen(db, tenantId, threadId)
  if (!r) throw new OutreachError('not_found')
  if (!recipientAllowed(db,tenantId,r.to_email)) throw new OutreachError('personal_email')
  if (leadHeld(db,tenantId,r.lead_id)) throw new OutreachError('lead_ungraded')
  if (r.status === 'sent') throw new OutreachError('already_sent')
  if (r.status === 'skipped') throw new OutreachError('final')
  // 'approved' is the in-flight claim: a send started and its outcome was never recorded.
  if (r.status === 'approved') throw new OutreachError('send_uncertain')
  if (isSuppressed(db, tenantId, r.to_email)) throw new OutreachError('suppressed')
  // Same account-level stop as the first-email, follow-up and sequence sends: while any send's outcome is unknown
  // (uncertain), nothing else goes out for this tenant until the user resolves it.
  if (anyUncertainSend(db, tenantId)) throw new OutreachError('already_uncertain')
  if (accountPaused(db, tenantId)) throw new OutreachError('paused')
  leadGates(db, tenantId, r)
  const settings = getSettings(db, tenantId)
  const acct = gmailStatus(db, tenantId)
  if (!settings || acct?.status !== 'active') throw new OutreachError('gmail_not_connected')
  const t = qualify(db, tenantId, threadId)
  const orig = db.prepare('SELECT id, subject FROM outreach_messages WHERE tenant_id = ? AND lead_id = ?').get(tenantId, t.lead_id) as { id: string; subject: string } | undefined
  if (!orig) throw new OutreachError('root_missing')
  const master = d.master ?? getMasterKey()
  const unsubUrl = `${(d.baseUrl ?? process.env.PUBLIC_BASE_URL ?? 'https://dazl.ai').replace(/\/$/, '')}/api/unsubscribe?t=${unsubToken(orig.id, master)}`
  const now = d.now ?? Math.floor(Date.now() / 1000)
  let token: string
  try { token = await getAccessToken(db, tenantId, d as OAuthDeps) } catch { throw new OutreachError('gmail_reconnect_needed') }
  if (!recipientAllowed(db,tenantId,r.to_email)) throw new OutreachError('personal_email')
  if (leadHeld(db,tenantId,r.lead_id)) throw new OutreachError('lead_ungraded')
  if (isSuppressed(db, tenantId, r.to_email)) throw new OutreachError('suppressed')
  leadGates(db, tenantId, r)
  if (accountPaused(db, tenantId)) throw new OutreachError('paused') // a pause during the token await still holds this send
  // At-most-once: claim the draft atomically right before the send. No await sits between the last check and
  // this claim, so a second click, tab or process cannot also pass it. The body is re-read after the claim so the
  // send uses exactly the row it claimed.
  // The lead gates and the claim are one write transaction (the lock the identity review action takes): a withdraw cannot land between them.
  const claimed = db.transaction(() => { leadGates(db, tenantId, r); return db.prepare("UPDATE reopen_messages SET status = 'approved', sent_at = ? WHERE tenant_id = ? AND thread_id = ? AND status = 'draft'").run(now, tenantId, threadId) }).immediate()
  if (claimed.changes !== 1) throw new OutreachError(getReopen(db, tenantId, threadId)?.status === 'sent' ? 'already_sent' : 'send_uncertain')
  // Same shared 24h cap as the other send paths; this claim counts itself. Over the cap: nothing was sent, so hand
  // the draft back (the user can send it later) rather than leaving an unresolved claim.
  if (accountSendCount(db, tenantId, now) > DAILY_CAP) {
    db.prepare("UPDATE reopen_messages SET status = 'draft', sent_at = NULL WHERE tenant_id = ? AND thread_id = ? AND status = 'approved'").run(tenantId, threadId)
    throw new OutreachError('daily_cap')
  }
  const r2 = getReopen(db, tenantId, threadId)!
  const raw = toBase64Url(buildMime({ fromName: settings.sender_name, fromEmail: acct.email, to: r2.to_email, subject: orig.subject.startsWith('Re:') ? orig.subject : `Re: ${orig.subject}`, body: composeBody(r2.body, settings, unsubUrl), messageId: `dazl.reopen.${orig.id}@${acct.email.split('@')[1]}`, unsubscribeUrl: unsubUrl, date: new Date(now * 1000), inReplyTo: t.root_message_id }))
  // A throw here may still mean the mail was delivered. Leave the claim in place (never resend) and report it.
  // gmailSend aborts after 20s and the token fetch (before this claim) after 15s, so a real send cannot outlive the
  // 10 minute lease; the in-process set below also refuses a resolve while this call is still running here.
  const opKey = `${tenantId}|${threadId}`
  inFlight.add(opKey)
  let res: { id: string }
  try { res = await (d.sendFn ?? gmailSend)(token, raw, d.fetchImpl, threadId) } catch { throw new OutreachError('send_uncertain') } finally { inFlight.delete(opKey) }
  // Operation identity is the claim time: only the claim this call made may be completed by it. A newer claim, a
  // resolve or a skip is never overwritten. If the user reset the row to a draft meanwhile (no newer claim exists),
  // the mail did go out, so the draft is closed as sent rather than left to be sent again.
  const done = db.prepare("UPDATE reopen_messages SET status = 'sent', gmail_id = ?, sent_at = ? WHERE tenant_id = ? AND thread_id = ? AND ((status = 'approved' AND sent_at = ?) OR (status = 'draft' AND sent_at IS NULL))").run(res.id, now, tenantId, threadId, now)
  if (done.changes !== 1) throw new OutreachError('send_uncertain') // delivered, but the row moved on: do not touch it, tell the user
  db.prepare("UPDATE followup_threads SET stopped = 'reopened', last_activity_at = ? WHERE tenant_id = ? AND thread_id = ?").run(now, tenantId, threadId)
}

// No schema change: while a re-open is 'approved', sent_at holds the CLAIM time (the lease start); a successful send
// overwrites it with the delivery time and a return to draft clears it. 'approved' is therefore either
//   active    - claimed less than SENDING_STALE_S ago: the Gmail call may still be running, or
//   uncertain - older: the process died or the call never reported back; it may or may not have been delivered.
// Only an uncertain claim can be resolved. Resolving never sends, and an active claim is never touched.
// Re-opens whose Gmail call is running in this process right now. Never resolvable, whatever the clock says.
const inFlight = new Set<string>()
export function reopenClaimState(r: { status: string; sent_at: number | null }, now: number): 'active' | 'uncertain' | null {
  if (r.status !== 'approved') return null
  return r.sent_at !== null && now - r.sent_at < SENDING_STALE_S ? 'active' : 'uncertain'
}
// The user checked Gmail Sent. 'sent' records it as delivered (their word, no Gmail id; the claim time stays as the
// best known time). 'retry' puts the draft back for review; it still needs a fresh press of Send.
export function resolveReopen(db: Database.Database, tenantId: string, threadId: string, as: 'sent' | 'retry', now = Math.floor(Date.now() / 1000)): void {
  const r = db.prepare('SELECT status, sent_at FROM reopen_messages WHERE tenant_id = ? AND thread_id = ?').get(tenantId, threadId) as { status: string; sent_at: number | null } | undefined
  if (!r) throw new OutreachError('not_found')
  const st = inFlight.has(`${tenantId}|${threadId}`) ? 'active' : reopenClaimState(r, now)
  if (st === null) throw new OutreachError('not_uncertain')
  if (st === 'active') throw new OutreachError('send_in_progress')
  const stale = now - SENDING_STALE_S
  const res = as === 'sent'
    ? db.prepare("UPDATE reopen_messages SET status = 'sent', sent_at = COALESCE(sent_at, ?) WHERE tenant_id = ? AND thread_id = ? AND status = 'approved' AND (sent_at IS NULL OR sent_at <= ?)").run(now, tenantId, threadId, stale)
    : db.prepare("UPDATE reopen_messages SET status = 'draft', sent_at = NULL WHERE tenant_id = ? AND thread_id = ? AND status = 'approved' AND (sent_at IS NULL OR sent_at <= ?)").run(tenantId, threadId, stale)
  if (res.changes !== 1) throw new OutreachError('not_uncertain')
}
