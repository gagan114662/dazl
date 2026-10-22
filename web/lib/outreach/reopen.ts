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
import { composeBody, getSettings, isSuppressed, OutreachError, unsubToken, type Deps } from './service.ts'

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
  db.prepare('UPDATE reopen_messages SET body = ? WHERE tenant_id = ? AND thread_id = ?').run(b, tenantId, threadId)
}

export function skipReopen(db: Database.Database, tenantId: string, threadId: string): void {
  const r = getReopen(db, tenantId, threadId)
  if (!r) throw new OutreachError('not_found')
  if (r.status === 'sent' || r.status === 'skipped') throw new OutreachError('final')
  db.prepare("UPDATE reopen_messages SET status = 'skipped' WHERE tenant_id = ? AND thread_id = ?").run(tenantId, threadId)
}

// The user reviewed the draft in the UI and pressed send. Suppression is re-checked here.
export async function sendReopen(db: Database.Database, tenantId: string, threadId: string, d: Deps & { now?: number } = {}): Promise<void> {
  const r = getReopen(db, tenantId, threadId)
  if (!r) throw new OutreachError('not_found')
  if (r.status === 'sent') throw new OutreachError('already_sent')
  if (r.status === 'skipped') throw new OutreachError('final')
  if (isSuppressed(db, tenantId, r.to_email)) throw new OutreachError('suppressed')
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
  const raw = toBase64Url(buildMime({ fromName: settings.sender_name, fromEmail: acct.email, to: r.to_email, subject: orig.subject.startsWith('Re:') ? orig.subject : `Re: ${orig.subject}`, body: composeBody(r.body, settings, unsubUrl), messageId: `dazl.reopen.${orig.id}@${acct.email.split('@')[1]}`, unsubscribeUrl: unsubUrl, date: new Date(now * 1000), inReplyTo: t.root_message_id }))
  const res = await (d.sendFn ?? gmailSend)(token, raw, d.fetchImpl, threadId)
  db.prepare("UPDATE reopen_messages SET status = 'sent', gmail_id = ?, sent_at = ? WHERE tenant_id = ? AND thread_id = ?").run(res.id, now, tenantId, threadId)
  db.prepare("UPDATE followup_threads SET stopped = 'reopened', last_activity_at = ? WHERE tenant_id = ? AND thread_id = ?").run(now, tenantId, threadId)
}
