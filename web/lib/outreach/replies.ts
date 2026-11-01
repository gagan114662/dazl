import { tableExists } from './send-budget.ts'
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getAccessToken, type OAuthDeps } from '../gmail/oauth.ts'
import { isStaging } from '../staging.ts'
import { auditAt, recordBounce } from './autopilot.ts'
import { grantConsent, revokeAll } from './ledger.ts'
import { norm } from './store.ts'
import { suppress } from './service.ts'
import { fullText, messageText, type GPart } from './reply-text.ts'
export { newText, messageText, htmlToText } from './reply-text.ts'

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
    -- Inbox read state (lib/outreach/inbox.ts): the newest reply time the owner has seen in a thread; a thread is unread
    -- while a reply is newer than this.
    CREATE TABLE IF NOT EXISTS inbox_thread_reads (tenant_id TEXT NOT NULL, thread_id TEXT NOT NULL, read_upto INTEGER NOT NULL, PRIMARY KEY (tenant_id, thread_id));
    CREATE INDEX IF NOT EXISTS inbound_messages_thread ON inbound_messages (tenant_id, thread_id, received_at);
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
// opt_out / negative: stop and suppress (future sends to the address too). positive: the only class that can grant
// consent, English phrases only, and never when any opt-out, negative or ambiguous wording is present. uncertain: the
// reply could not be read (malformed, empty, attachments only), uses wording that might be an opt-out ("stop",
// "remove", "spam"...), or is in a script these rules do not read: it BLOCKS the thread for human review (no
// automated follow-up, consent revoked) without suppressing anyone. other: read, nothing recognised, review only.
export type ReplyClass = 'opt_out' | 'negative' | 'positive' | 'auto' | 'uncertain' | 'other'
// A phrase is matched as whole words, in any language (letters on either side mean another word).
const words = (alts: string[]) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join('|')})(?![\\p{L}\\p{N}])`, 'iu')
const OPT_OUT = words([
  // English
  'unsubscribe', 'remove me', 'stop (?:emailing|email|contacting|sending|messaging|reaching out)', 'do not (?:contact|email|reach out)', "don'?t (?:contact|email|reach out)", 'take me off', 'opt[- ]?out', 'cease',
  'never (?:contact|email|message) (?:me|us)', 'leave me alone', "(?:do not|don'?t) send (?:me |us )?(?:any )?(?:more )?(?:e-?mails?|messages?)",
  'no more (?:e-?mails?|messages?)', 'take (?:me|us) out of', 'remove (?:my|our) (?:address|e-?mail)',
  // Spanish, French, German, Portuguese, Italian, Dutch
  'dar(?:me)? de baja', 'darse de baja', 'no me (?:escriban?|contacte[ns]?|env[ií]e[ns]?)', 'el[ií]min(?:a|e|en)(?:me)? de (?:su|la|vuestra) lista', 'quitar(?:me)? de (?:su|la) lista',
  'd[ée]sinscri(?:re|vez|vez-moi|ption)', 'd[ée]sabonn(?:er|ez|ement)', 'retirez[- ]moi', "ne m'(?:[ée]crivez|contactez|envoyez) plus", 'ne plus me (?:contacter|[ée]crire)',
  'abmelden', 'austragen', 'tragen sie mich aus', 'keine (?:weiteren )?(?:e-?mails|nachrichten|kontaktaufnahme)', 'kontaktieren sie mich nicht',
  'descadastr(?:ar|e|e-me)', 'cancelar (?:a )?inscri[cç][aã]o', 'remov(?:a|er)(?:-me)? da (?:sua )?lista', 'n[aã]o me (?:envie|contate|contacte|mande)',
  'cancellami', 'disiscriv(?:i|ere|etemi)', 'rimuovetemi', 'non (?:mi )?(?:contattate|scrivete) pi[uù]',
  'afmelden', 'uitschrijven', 'schrijf me uit', 'geen (?:e-?mails|berichten) meer',
])
const NEGATIVE = words([
  'not interested', 'no thanks', 'no thank you', 'not for us', 'not a fit', 'no longer interested', 'wrong person',
  // explicit rejections: a later positive word never turns them into interest
  'hard pass', "(?:i'?ll|we'?ll|i will|we will|going to|gonna) pass", 'pass(?: on this| for now| on that)', 'zero interest', 'no interest',
  'not for me', "(?:we'?re|i'?m) (?:all )?(?:good|set)(?:,? thanks)?", '(?:politely |respectfully )?decline', 'thanks,? but no',
  'no (?:me |nos )?interesa', 'no estoy interesad[oa]', 'no estamos interesados', 'pas int[ée]ress[ée]e?s?', 'non merci',
  'kein interesse', 'nicht interessiert', 'n[aã]o tenho interesse', 'n[aã]o estou interessad[oa]', 'non sono interessat[oa]', 'non siamo interessati',
  'geen interesse', 'niet ge[ïi]nteresseerd',
])
// Might be an opt-out, might not: a person reads it.
const AMBIGUOUS = words(['stop', 'stopp', 'remove', 'unsub\\p{L}*', 'spam', 'abuse', 'gdpr', 'dsgvo', 'rgpd', 'lgpd', 'baja', 'block(?:ed)?', 'blacklist', 'report(?:ed)? (?:you|this)', 'how did you get my'])
// Any negation or hedge anywhere in a reply that also says something positive ("Not really interested", "Please
// dont call me", "Maybe interested later", "Why would I be interested?"): the positive wording cannot be trusted, so a
// person reads it.
const NEGATION = words(['not', 'never', 'no', 'nope', 'no longer', 'rather not', "\\p{L}+n['\u2019]t", 'dont', 'cant', 'wont', 'isnt', 'arent', 'doesnt', 'didnt', 'wouldnt', 'shouldnt', 'couldnt', 'havent', 'hasnt', 'wasnt', 'werent', 'cannot', 'aint', 'nah', 'hardly', 'barely', 'neither', 'without',
  'pass', 'zero', 'maybe', 'perhaps', 'possibly', 'might', 'doubt\\p{L}*', 'unlikely', 'later', 'someday', 'would have', 'if ever', 'why (?:would|should)',
  'pas', 'jamais', 'kein\\p{L}*', 'nicht', 'nein', 'n[aã]o', 'non', 'nunca', 'mai', 'niet', 'geen', 'nooit'])
const POSITIVE = /\b(interested|tell me more|send (me )?(more )?(info|information|details)|sounds good|let'?s (talk|chat|connect|schedule|set up)|call me|book (a|the) (call|time|meeting)|yes,? please|happy to (chat|talk|connect))\b/i
const AUTO_SUBJECT = /^(automatic reply|auto[- ]?reply|autoreply|out of (the )?office|abwesenheitsnotiz|automatische antwort|r[ée]ponse automatique|absence|respuesta autom[áa]tica|resposta autom[áa]tica|risposta automatica|automatisch antwoord)/i
// Letters outside the Latin script (Cyrillic, Greek, CJK, Arabic, Hebrew...): these rules do not read them.
const nonLatinShare = (t: string) => { const l = t.match(/\p{L}/gu) ?? []; return l.length ? l.filter(c => !/\p{Script=Latin}/u.test(c)).length / l.length : 0 }
export interface ReplyHeaders { autoSubmitted?: string; precedence?: string; subject?: string; xAutoreply?: string; xAutorespond?: string }
// Order matters: an unreadable body or any opt-out, negative or ambiguous wording wins over positive wording; unsure
// never grants consent. Auto-reply markers (a subject, a list header) change only the two outcomes that would credit the
// body as a person's answer: positive and other become auto (a template's "interested parties may call me" is no one's
// interest), and a blank auto-ack is auto. Every body guard below (unreadable, opt-out, negative, ambiguous, script the
// rules cannot read, positive next to a negation or hedge) applies with or without the markers, in one pass.
export function classifyReply(text: string, h: ReplyHeaders = {}, status: 'ok' | 'empty' | 'malformed' = 'ok'): ReplyClass {
  const auto = (h.autoSubmitted && h.autoSubmitted.toLowerCase() !== 'no') || /^(bulk|junk|auto_reply|list)$/i.test(h.precedence ?? '') || !!h.xAutoreply || !!h.xAutorespond || AUTO_SUBJECT.test(h.subject ?? '')
  if (auto && status !== 'malformed' && !text.trim()) return 'auto'
  const body = bodyClass(text, status)
  return auto && (body === 'positive' || body === 'other') ? 'auto' : body
}
function bodyClass(text: string, status: 'ok' | 'empty' | 'malformed'): ReplyClass {
  if (status !== 'ok' || !text.trim()) return 'uncertain'
  if (OPT_OUT.test(text)) return 'opt_out'
  if (NEGATIVE.test(text)) return 'negative'
  if (AMBIGUOUS.test(text)) return 'uncertain'
  if (nonLatinShare(text) > 0.2) return 'uncertain'
  if (POSITIVE.test(text)) return NEGATION.test(text) ? 'uncertain' : 'positive'
  return 'other'
}

// One message, all of its readable bodies. When the plain and HTML alternatives disagree, no body is trusted to grant
// anything: an explicit opt-out in either is honoured (the recipient asked to stop), any other disagreement is held
// for review (uncertain), and positive only stands when both bodies say it.
export function classifyMessage(t: { text: string; status: 'ok' | 'empty' | 'malformed'; alt?: string | null; addrTail?: string }, h: ReplyHeaders = {}): ReplyClass {
  const cls = classifyBodies(t, h)
  // The text was cut at an address-style line we cannot place (lib/outreach/reply-text.ts): what follows is probably the
  // quoted earlier message, but it may be the lead's own words. That boundary is uncertain, so the thread is held for
  // review (uncertain: follow-ups stop, earlier consent revoked) whatever the tail says and whatever auto-reply markers
  // the message has. The tail is never read as interest or as a fresh opt-out (no suppression); only an opt-out in the
  // new text itself is honoured as one.
  if (t.addrTail && cls !== 'opt_out') return 'uncertain'
  return cls
}
function classifyBodies(t: { text: string; status: 'ok' | 'empty' | 'malformed'; alt?: string | null }, h: ReplyHeaders): ReplyClass {
  const first = classifyReply(t.text, h, t.status)
  if (t.alt === undefined) return first
  const second = t.alt === null ? classifyReply('', h, 'malformed') : classifyReply(t.alt, h, 'ok')
  if (first === second) return first
  if (first === 'opt_out' || second === 'opt_out') return 'opt_out'
  // under auto-reply markers both bodies were read the same way: whatever one of them says beyond "auto" stands
  if (first === 'auto' || second === 'auto') return first === 'auto' ? second : first
  return 'uncertain'
}

// ---------- Gmail reading (thread ids only) ----------
interface GMsg { id: string; threadId: string; internalDate?: string; payload?: GPart }
const header = (m: GMsg, n: string) => m.payload?.headers?.find(h => h.name.toLowerCase() === n)?.value
const addr = (v?: string) => norm((v?.match(/<([^>]+)>/)?.[1] ?? v ?? '').trim())

// ---- Separate-thread delivery-failure notices (#415) ----
// A delivery-status notice (RFC 3464 DSN) can arrive on its OWN thread, outside the outreach thread. The read
// consent text already names "delivery-failure notices for them" (the threads dazl started), so the only mailbox
// listing below is daemon notices inside the sync window: no other mail is listed, read or processed.
interface DsnReport { recipient: string | null; status: string | null; failed: boolean; messageRef: string | null }

const dsnFields = (text: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z-]+):\s*(.+)$/.exec(line.trim())
    if (m) out[m[1].toLowerCase()] = m[2].trim()
  }
  return out
}

// Structured evidence only: the delivery-status part (or the daemon's own X-Failed-Recipients), never a code or an
// address quoted in the human-readable text. A notice that carries none of this structure reports nothing.
function dsnFromNotice(g: GMsg): DsnReport {
  const heads = g.payload?.headers ?? []
  const hval = (n: string) => heads.find(h => h.name.toLowerCase() === n)?.value
  const ref = hval('original-message-id') ?? hval('references') ?? hval('in-reply-to') ?? null
  let recipient: string | null = addr(hval('x-failed-recipients')) || null
  let status: string | null = null
  let action: string | null = null
  const walk = (p?: GPart) => {
    if (!p) return
    if (p.mimeType === 'message/delivery-status' && p.body?.data) {
      const f = dsnFields(Buffer.from(p.body.data, 'base64url').toString('utf8'))
      if (f['final-recipient']) recipient = addr(f['final-recipient'].split(';').pop() ?? '')
      if (f['action']) action = f['action'].toLowerCase()
      if (f['status']) status = f['status']
    }
    for (const q of p.parts ?? []) walk(q)
  }
  walk(g.payload)
  const messageRef = ref && /dazl\.[a-z0-9]+@/i.test(ref) ? ref : null
  return { recipient, status, failed: action === 'failed', messageRef }
}

export interface SyncDeps extends OAuthDeps { fetchImpl?: typeof fetch }
export interface SyncResult { threads: number; replies: number; optOuts: number; bounces: number; consents: number; reviews: number; error?: string }

export async function syncReplies(db: Database.Database, tenantId: string, d: SyncDeps = {}): Promise<SyncResult> {
  const out: SyncResult = { threads: 0, replies: 0, optOuts: 0, bounces: 0, consents: 0, reviews: 0 }
  const now = d.now ?? Math.floor(Date.now() / 1000)
  const acct = db.prepare('SELECT email, read_granted, status FROM gmail_accounts WHERE tenant_id = ?').get(tenantId) as { email: string; read_granted: number; status: string } | undefined
  if (!hasReadConsent(db, tenantId) || !acct || acct.read_granted !== 1 || acct.status !== 'active') return { ...out, error: 'reading_not_enabled' }
  const f = d.fetchImpl ?? fetch
  let token: string
  try { token = await getAccessToken(db, tenantId, d) } catch { return { ...out, error: 'gmail_unavailable' } }
  if (isStaging((d.env ?? process.env) as Record<string, string | undefined>)) return out // stubbed Gmail: no mailbox to read
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
        const body = messageText(g.payload)
        const text = body.text
        const log = (cls: string) => db.prepare('INSERT OR IGNORE INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at, outreach_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(g.id, tenantId, thread, m.lead_id, from, text.slice(0, 200), cls, at, m.id)
        // Delivery-failure notice: only a permanent (5.x.x) failure suppresses.
        if (/^(mailer-daemon|postmaster)@/.test(from)) {
          const full = fullText(g.payload)
          if (/\b5\.\d{1,3}\.\d{1,3}\b/.test(full)) { recordBounce(db, tenantId, m.to_email, now); db.prepare("UPDATE followup_threads SET stopped = 'bounce' WHERE tenant_id = ? AND thread_id = ?").run(tenantId, thread); out.bounces++; log('bounce') } else log('soft_bounce')
          continue
        }
        const cls = classifyMessage(body, { autoSubmitted: header(g, 'auto-submitted'), precedence: header(g, 'precedence'), subject: header(g, 'subject'), xAutoreply: header(g, 'x-autoreply'), xAutorespond: header(g, 'x-autorespond') })
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
        } else if (cls === 'uncertain') {
          // Blocked for review: no automated follow-up on this thread and no consent stands for either address until a
          // person has read it. Nobody is suppressed: an unclear message is not taken as an opt-out (or as interest).
          for (const e of new Set([from, m.to_email])) revokeAll(db, tenantId, e, 'reply_uncertain', now)
          // a thread already stopped for a stronger reason (opt-out, no, bounce) keeps that reason
          db.prepare("UPDATE followup_threads SET stopped = 'review' WHERE tenant_id = ? AND thread_id = ? AND stopped IS NULL").run(tenantId, thread)
          auditAt(db, tenantId, 'reply_blocked_for_review', body.status === 'ok' ? 'unclear wording' : `body ${body.status}`, m.lead_id, m.id, now); out.reviews++
        } else auditAt(db, tenantId, 'reply_for_review', cls, m.lead_id, m.id, now)
      }
    } catch (e) {
      out.error = 'reply_sync_failed' // fail closed: the scheduler must not treat a partial sync as fresh
      auditAt(db, tenantId, 'sync_error', e instanceof Error ? e.message : 'error', m.lead_id, m.id, now)
    }
  }
  // Phase 2 (#415): daemon notices on their own threads, correlated to the exact recorded send before anything is
  // suppressed. Window: since the last successful sync, never wider than 7 days (first sync: 2 days).
  try {
    const prev = tableExists(db, 'scheduler_progress') ? (db.prepare("SELECT last_success_at FROM scheduler_progress WHERE tenant_id = ? AND kind = 'reply_sync'").get(tenantId) as { last_success_at: number | null } | undefined)?.last_success_at : null
    const since = prev ? Math.max(prev, now - 7 * 86400) : now - 2 * 86400
    const q = encodeURIComponent(`from:mailer-daemon OR from:postmaster after:${since}`)
    const list = (await get(`messages?q=${q}&maxResults=50`)) as { messages?: { id: string }[] }
    for (const hit of list.messages ?? []) {
      if (db.prepare('SELECT 1 FROM inbound_messages WHERE tenant_id = ? AND gmail_id = ?').get(tenantId, hit.id)) continue // increments once: seen notices are never reprocessed
      const g = (await get(`messages/${hit.id}?format=full`)) as GMsg
      const at = Math.floor(Number(g.internalDate ?? 0) / 1000) || now
      const from = addr(header(g, 'from'))
      // Retention minimum for anything that does not correlate to an exact recorded send: the opaque id (for
      // one-time accounting), the time and the classification. No sender, recipient or content of mail that may
      // not be ours - the read consent covers replies and delivery notices FOR OUR THREADS only.
      const logUnmatched = () => db.prepare('INSERT OR IGNORE INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at, outreach_message_id) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL)').run(hit.id, tenantId, g.threadId ?? '', '', '', 'bounce_unmatched', at)
      if (!/^(mailer-daemon|postmaster)@/.test(from)) { logUnmatched(); continue }
      const dsn = dsnFromNotice(g)
      // Correlate to the exact recorded send: the notice must reference our Message-ID AND name the recipient we
      // wrote to. BOTH, always: a From line matching mailer-daemon is not authentication (anyone can set it), so
      // no-reference notices - even genuine-looking 5.x.x ones naming a real sole recipient - can never suppress,
      // stop a thread or end a sequence. They are counted unmatched and left for review.
      const refId = dsn.messageRef ? /dazl\.([a-z0-9]+)@/i.exec(dsn.messageRef)?.[1] ?? null : null
      let m: { id: string; lead_id: string; to_email: string } | undefined
      if (refId && dsn.recipient) m = (db.prepare("SELECT id, lead_id, to_email FROM outreach_messages WHERE tenant_id = ? AND id = ? AND status IN ('sent','sending','uncertain')").get(tenantId, refId) as typeof m) ?? undefined
      if (m && norm(m.to_email) !== dsn.recipient) m = undefined // the notice must name who we actually wrote to
      const log = (cls: string, mid: string | null, leadId: string | null) => db.prepare('INSERT OR IGNORE INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at, outreach_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(hit.id, tenantId, g.threadId ?? '', leadId, from, `dsn status ${dsn.status ?? 'none'}`, cls, at, mid)
      if (!m || !dsn.failed || !dsn.status) {
        logUnmatched()
        auditAt(db, tenantId, 'bounce_unmatched', 'no exact send correlation', undefined, undefined, now)
        continue
      }
      if (/^5\.\d{1,3}\.\d{1,3}$/.test(dsn.status)) {
        // A permanent failure: suppress the exact recipient, stop their threads and sequences, account once per send.
        if (!db.prepare("SELECT 1 FROM inbound_messages WHERE tenant_id = ? AND outreach_message_id = ? AND classification = 'bounce'").get(tenantId, m.id)) {
          recordBounce(db, tenantId, m.to_email, now)
          db.prepare("UPDATE followup_threads SET stopped = 'bounce' WHERE tenant_id = ? AND to_email = ?").run(tenantId, m.to_email)
          auditAt(db, tenantId, 'bounce_separate_thread', `${m.to_email} (dsn ${dsn.status})`, m.lead_id, m.id, now)
          out.bounces++
        }
        log('bounce', m.id, m.lead_id)
      } else log('soft_bounce', m.id, m.lead_id) // 4.x.x and anything non-permanent: never a suppression
    }
  } catch (e) {
    out.error = 'reply_sync_failed' // fail closed, same contract as the thread loop
    auditAt(db, tenantId, 'sync_error', `delivery notices: ${e instanceof Error ? e.message : 'error'}`, undefined, undefined, now)
  }
  return out
}

// The Inbox list itself (one row per thread, paginated and filtered on the server) is lib/outreach/inbox.ts.
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
