import { tableExists } from './send-budget.ts'
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getAccessToken, type OAuthDeps } from '../gmail/oauth.ts'
import { auditAt, recordBounce } from './autopilot.ts'
import { grantConsent, revokeAll } from './ledger.ts'
import { norm } from './store.ts'
import { suppress } from './service.ts'

// Reading replies is its own consent and its own Gmail scope (gmail.readonly). dazl opens only threads it started,
// by thread id. It never lists or searches the mailbox, stores only a 200-character excerpt of a reply, and
// reads nothing when the user has not consented or has turned it off.
export const READ_CONSENT_VERSION = '2026-10-21'
export const READ_CONSENT_TEXT = [
  'dazl will read replies in the email threads it started for you, and delivery-failure notices for them. It will not read any other email.',
  'It uses this to stop emailing people who unsubscribe or bounce, to stop cold sequences on any human reply, and to start separately approved warm follow-ups for interested replies.',
  'dazl keeps the sender, the time, a short excerpt and the result. It does not keep full reply bodies.',
  'You can turn this off any time. Turning it off stops reading and follow-ups.',
]

export function migrateReplies(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mail_read_consent (tenant_id TEXT PRIMARY KEY, version TEXT NOT NULL, accepted_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)));
    CREATE TABLE IF NOT EXISTS inbound_messages (
      gmail_id TEXT NOT NULL, tenant_id TEXT NOT NULL, thread_id TEXT NOT NULL, lead_id TEXT, from_email TEXT NOT NULL,
      excerpt TEXT NOT NULL CHECK (length(excerpt) <= 200), classification TEXT NOT NULL, received_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, gmail_id)
    );
    -- State of one thread for follow-ups.
    CREATE TABLE IF NOT EXISTS followup_threads (
      tenant_id TEXT NOT NULL, thread_id TEXT NOT NULL, lead_id TEXT NOT NULL, to_email TEXT NOT NULL, root_message_id TEXT NOT NULL,
      last_activity_at INTEGER NOT NULL, last_lead_reply_at INTEGER, followups_sent INTEGER NOT NULL DEFAULT 0, last_followup_at INTEGER,
      stopped TEXT CHECK (stopped IS NULL OR length(stopped) <= 40),
      PRIMARY KEY (tenant_id, thread_id)
    );
    CREATE TABLE IF NOT EXISTS followup_messages (
      tenant_id TEXT NOT NULL, thread_id TEXT NOT NULL, step INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('sending','sent','uncertain')),
      gmail_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (tenant_id, thread_id, step)
    );
  `)
  const columns = db.prepare('PRAGMA table_info(inbound_messages)').all() as { name: string }[]
  if (!columns.some(c => c.name === 'outreach_message_id')) db.exec('ALTER TABLE inbound_messages ADD COLUMN outreach_message_id TEXT')
}

export const acceptReadConsent = (db: Database.Database, tenantId: string) =>
  db.prepare("INSERT INTO mail_read_consent (tenant_id, version) VALUES (?, ?) ON CONFLICT(tenant_id) DO UPDATE SET version = excluded.version, accepted_at = CAST(strftime('%s','now') AS INTEGER)").run(tenantId, READ_CONSENT_VERSION)
export const revokeReadConsent = (db: Database.Database, tenantId: string) => {
  db.prepare('DELETE FROM mail_read_consent WHERE tenant_id = ?').run(tenantId)
  db.prepare('UPDATE autopilot_settings SET followups_enabled = 0 WHERE tenant_id = ?').run(tenantId)
}
export const hasReadConsent = (db: Database.Database, tenantId: string) =>
  (db.prepare('SELECT version FROM mail_read_consent WHERE tenant_id = ?').get(tenantId) as { version: string } | undefined)?.version === READ_CONSENT_VERSION

// ---------- classification (rules only; conservative) ----------
export type ReplyClass = 'opt_out' | 'negative' | 'positive' | 'auto' | 'other'
const OPT_OUT = /\b(unsubscribe|remove me|stop (emailing|email|contacting|sending|messaging)|do not (contact|email)|don'?t (contact|email)|take me off|opt[- ]?out|cease)\b/i
const NEGATIVE = /\b(not interested|no thanks|no thank you|not for us|not a fit|no longer interested|wrong person)\b/i
const POSITIVE = /\b(interested|tell me more|send (me )?(more )?(info|information|details)|sounds good|let'?s (talk|chat|connect|schedule|set up)|call me|book (a|the) (call|time|meeting)|yes,? please|happy to (chat|talk|connect))\b/i
// Order matters: any opt-out or negative wording wins over positive wording. Unsure means 'other', which never grants consent.
export function classifyReply(text: string, h: { autoSubmitted?: string; precedence?: string; subject?: string } = {}): ReplyClass {
  if ((h.autoSubmitted && h.autoSubmitted.toLowerCase() !== 'no') || /^(bulk|junk|auto_reply)$/i.test(h.precedence ?? '') || /^(automatic reply|auto[- ]?reply|out of office)/i.test(h.subject ?? '')) return 'auto'
  if (OPT_OUT.test(text)) return 'opt_out'
  if (NEGATIVE.test(text)) return 'negative'
  if (POSITIVE.test(text)) return 'positive'
  return 'other'
}

// ---------- Gmail reading (thread ids only) ----------
interface GPart { mimeType?: string; body?: { data?: string }; parts?: GPart[]; headers?: { name: string; value: string }[] }
interface GMsg { id: string; threadId: string; internalDate?: string; payload?: GPart }
const header = (m: GMsg, n: string) => m.payload?.headers?.find(h => h.name.toLowerCase() === n)?.value
function plainText(p?: GPart): string {
  if (!p) return ''
  if (p.mimeType === 'text/plain' && p.body?.data) return Buffer.from(p.body.data, 'base64url').toString('utf8')
  for (const c of p.parts ?? []) { const t = plainText(c); if (t) return t }
  return ''
}
// Only the new text: drop quoted lines and the "On ... wrote:" tail.
export function newText(t: string): string {
  const cut = t.split(/\r?\n(?:On .{0,120}wrote:|-{2,}\s*Original Message|From: )/)[0]
  return cut.split(/\r?\n/).filter(l => !l.startsWith('>')).join(' ').replace(/\s+/g, ' ').trim()
}
const addr = (v?: string) => norm((v?.match(/<([^>]+)>/)?.[1] ?? v ?? '').trim())

export interface SyncDeps extends OAuthDeps { fetchImpl?: typeof fetch }
export interface SyncResult { threads: number; replies: number; optOuts: number; bounces: number; consents: number; error?: string }

export async function syncReplies(db: Database.Database, tenantId: string, d: SyncDeps = {}): Promise<SyncResult> {
  const out: SyncResult = { threads: 0, replies: 0, optOuts: 0, bounces: 0, consents: 0 }
  const now = d.now ?? Math.floor(Date.now() / 1000)
  const acct = db.prepare('SELECT email, read_granted, status FROM gmail_accounts WHERE tenant_id = ?').get(tenantId) as { email: string; read_granted: number; status: string } | undefined
  if (!hasReadConsent(db, tenantId) || !acct || acct.read_granted !== 1 || acct.status !== 'active') return { ...out, error: 'reading_not_enabled' }
  const f = d.fetchImpl ?? fetch
  let token: string
  try { token = await getAccessToken(db, tenantId, d) } catch { return { ...out, error: 'gmail_unavailable' } }
  const get = async (path: string) => { const r = await f(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) }); if (!r.ok) throw new Error(`gmail_${r.status}`); return r.json() }

  const seqPriority = tableExists(db, 'sequences') ? " OR id IN (SELECT message_id FROM sequences WHERE tenant_id = ? AND status IN ('approved','active'))" : ''
  const sent = db.prepare(`SELECT id, lead_id, to_email, gmail_id, thread_id, sent_at FROM outreach_messages WHERE tenant_id = ? AND status = 'sent' AND gmail_id IS NOT NULL AND (sent_at >= ? ${seqPriority}) ORDER BY sent_at DESC`).all(tenantId, now - 120 * 86400,...(seqPriority ? [tenantId] : [])) as { id: string; lead_id: string; to_email: string; gmail_id: string; thread_id: string | null; sent_at: number }[]
  for (const m of sent) {
    try {
      let thread = m.thread_id
      if (!thread) { thread = ((await get(`messages/${m.gmail_id}?format=minimal`)) as GMsg).threadId; db.prepare('UPDATE outreach_messages SET thread_id = ? WHERE id = ?').run(thread, m.id) }
      const t = (await get(`threads/${thread}?format=full`)) as { messages?: GMsg[] }
      out.threads++
      const root = `dazl.${m.id}@${acct.email.split('@')[1]}`
      db.prepare('INSERT OR IGNORE INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at) VALUES (?, ?, ?, ?, ?, ?)').run(tenantId, thread, m.lead_id, m.to_email, root, m.sent_at ?? now)
      for (const g of t.messages ?? []) {
        const at = Math.floor(Number(g.internalDate ?? 0) / 1000) || now
        const from = addr(header(g, 'from'))
        db.prepare('UPDATE followup_threads SET last_activity_at = max(last_activity_at, ?) WHERE tenant_id = ? AND thread_id = ?').run(at, tenantId, thread)
        if (from === acct.email) continue // our own or the user's message
        if (db.prepare('SELECT 1 FROM inbound_messages WHERE tenant_id = ? AND gmail_id = ?').get(tenantId, g.id)) continue
        const text = newText(plainText(g.payload))
        const log = (cls: string) => db.prepare('INSERT OR IGNORE INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at, outreach_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(g.id, tenantId, thread, m.lead_id, from, text.slice(0, 200), cls, at, m.id)
        // Delivery-failure notice: only a permanent (5.x.x) failure suppresses.
        if (/^(mailer-daemon|postmaster)@/.test(from)) {
          const full = plainText(g.payload)
          if (/\b5\.\d{1,3}\.\d{1,3}\b/.test(full)) { recordBounce(db, tenantId, m.to_email, now); db.prepare("UPDATE followup_threads SET stopped = 'bounce' WHERE tenant_id = ? AND thread_id = ?").run(tenantId, thread); out.bounces++; log('bounce') } else log('soft_bounce')
          continue
        }
        const cls = classifyReply(text, { autoSubmitted: header(g, 'auto-submitted'), precedence: header(g, 'precedence'), subject: header(g, 'subject') })
        log(cls)
        if (cls === 'auto') continue
        out.replies++
        if (tableExists(db,'sequences')) db.prepare("UPDATE sequences SET status = 'replied', stop_reason = 'reply' WHERE tenant_id = ? AND lead_id = ? AND status IN ('approved','active')").run(tenantId,m.lead_id)
        db.prepare('UPDATE followup_threads SET last_lead_reply_at = ? WHERE tenant_id = ? AND thread_id = ?').run(at, tenantId, thread)
        if (cls === 'opt_out' || cls === 'negative') {
          // An opt-out from anyone in the thread covers the person we wrote to. Nothing more goes to either address.
          for (const e of new Set([from, m.to_email])) { suppress(db, tenantId, e, cls === 'opt_out' ? 'unsubscribe' : 'manual'); revokeAll(db, tenantId, e, cls, now) }
          db.prepare("UPDATE followup_threads SET stopped = ? WHERE tenant_id = ? AND thread_id = ?").run(cls, tenantId, thread)
          auditAt(db, tenantId, cls === 'opt_out' ? 'reply_opt_out' : 'reply_negative', from, m.lead_id, m.id, now); out.optOuts++
        } else if (cls === 'positive' && from.split('@')[1] === m.to_email.split('@')[1]) {
          grantConsent(db, tenantId, from, { channel: 'email', scope: 'followup', basis: 'reply_interest', evidenceRef: `gmail:${g.id}`, now })
          auditAt(db, tenantId, 'consent_granted', `${from} replied with interest`, m.lead_id, m.id, now); out.consents++
        } else auditAt(db, tenantId, 'reply_for_review', cls, m.lead_id, m.id, now)
      }
    } catch (e) {
      out.error = 'reply_sync_failed' // fail closed: the scheduler must not treat a partial sync as fresh
      auditAt(db, tenantId, 'sync_error', e instanceof Error ? e.message : 'error', m.lead_id, m.id, now)
    }
  }
  return out
}

// Inbox surface: one row per captured reply with lead and follow-up state joined in.
export interface InboxRow { gmail_id: string; thread_id: string; lead_id: string | null; from_email: string; excerpt: string; classification: ReplyClass; received_at: number; company: string | null; lead_name: string | null; followups_sent: number | null; stopped: string | null }
export const inboxRows = (db: Database.Database, tenantId: string, limit = 100): InboxRow[] =>
  db.prepare(`SELECT m.gmail_id, m.thread_id, m.lead_id, m.from_email, m.excerpt, m.classification, m.received_at,
                     l.company, l.name AS lead_name, t.followups_sent, t.stopped
              FROM inbound_messages m
              LEFT JOIN leads l ON l.id = m.lead_id
              LEFT JOIN followup_threads t ON t.tenant_id = m.tenant_id AND t.thread_id = m.thread_id
              WHERE m.tenant_id = ? ORDER BY m.received_at DESC LIMIT ?`).all(tenantId, limit) as InboxRow[]

export const recentInbound = (db: Database.Database, tenantId: string, limit = 30) =>
  db.prepare('SELECT from_email, excerpt, classification, received_at FROM inbound_messages WHERE tenant_id = ? ORDER BY received_at DESC LIMIT ?').all(tenantId, limit) as { from_email: string; excerpt: string; classification: string; received_at: number }[]

// Thread view for the Inbox: the outreach emails dazl sent (the user's own words, full body)
// interleaved with the captured replies (excerpts only), oldest first.
export interface ThreadMsg { dir: 'out' | 'in'; kind: 'original' | 'followup' | 'reply'; subject: string | null; body: string; at: number; classification: string | null }
export function threadMessages(db: Database.Database, tenantId: string, threadId: string): ThreadMsg[] {
  const out: ThreadMsg[] = []
  const root = db.prepare(`SELECT m.subject, m.body, COALESCE(m.sent_at, m.created_at) AS at FROM followup_threads t
                           JOIN outreach_messages m ON m.lead_id = t.lead_id AND m.tenant_id = t.tenant_id
                           WHERE t.tenant_id = ? AND t.thread_id = ?`).get(tenantId, threadId) as { subject: string; body: string; at: number } | undefined
  if (!root) return [] // not this tenant's thread, or not an outreach thread at all
  out.push({ dir: 'out', kind: 'original', subject: root.subject, body: root.body, at: root.at, classification: null })
  for (const r of db.prepare('SELECT step, status, created_at FROM followup_messages WHERE tenant_id = ? AND thread_id = ?').all(tenantId, threadId) as { step: number; status: string; created_at: number }[])
    if (r.status === 'sent') out.push({ dir: 'out', kind: 'followup', subject: `Follow-up ${r.step + 1}`, body: '', at: r.created_at, classification: null })
  for (const r of db.prepare('SELECT excerpt, classification, received_at FROM inbound_messages WHERE tenant_id = ? AND thread_id = ?').all(tenantId, threadId) as { excerpt: string; classification: string; received_at: number }[])
    out.push({ dir: 'in', kind: 'reply', subject: null, body: r.excerpt, at: r.received_at, classification: r.classification })
  return out.sort((a, b) => a.at - b.at)
}

void randomBytes
