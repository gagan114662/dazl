import { tableExists } from './send-budget.ts'
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getAccessToken, type OAuthDeps } from '../gmail/oauth.ts'
import { gmailIsStubbed } from '../staging.ts'
import { auditAt } from './autopilot.ts'
import { grantConsent, revokeAll } from './ledger.ts'
import { norm, READ_CONSENT_VERSION } from './store.ts'
import { suppress } from './service.ts'
import { fullText, messageText, type GPart } from './reply-text.ts'
import { dsnProvenance } from './dsn.ts'
import { recheckReadAuthority } from './send-authority.ts'
import { applyBounceVerdict, migrateBounceLedger } from './bounce-ledger.ts'
export { newText, messageText, htmlToText } from './reply-text.ts'

// Reading replies is its own consent and its own Gmail scope (gmail.readonly). dazl opens its outreach threads and bounded candidate delivery notices,
// by thread id. It searches only the consent-disclosed bounded daemon-notice window beyond its own threads, stores only a 200-character excerpt of a reply, and
// reads nothing when the user has not consented or has turned it off.
export { READ_CONSENT_VERSION }
export { READ_CONSENT_TEXT } from './read-consent.ts'

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
  migrateBounceLedger(db) // both notice paths account through the one ledger (idempotent DDL, also run by the migration list)
}

export const acceptReadConsent = (db: Database.Database, tenantId: string) =>
  db.prepare("INSERT INTO mail_read_consent (tenant_id, version) VALUES (?, ?) ON CONFLICT(tenant_id) DO UPDATE SET version = excluded.version, accepted_at = CAST(strftime('%s','now') AS INTEGER)").run(tenantId, READ_CONSENT_VERSION)
// Whether a consent row (any version) was removed, so the caller can tell a revoke from a no-op.
export const revokeReadConsent = (db: Database.Database, tenantId: string): boolean => {
  const removed = db.prepare('DELETE FROM mail_read_consent WHERE tenant_id = ?').run(tenantId).changes > 0
  db.prepare('UPDATE autopilot_settings SET followups_enabled = 0 WHERE tenant_id = ?').run(tenantId)
  return removed
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
// A delivery-status notice (RFC 3464 DSN) can arrive on its OWN thread, outside the outreach thread, so it is matched
// to the send by what the notice itself carries - never by Gmail thread id. The read consent text already names
// these notices, so the only mailbox listing below is daemon notices inside the sync window: no other mail is
// listed, read or processed.
//
// Correlation keys (structured fields only, never a code or an address quoted in the human-readable text):
//   - the original Message-ID: the returned headers (message/rfc822 or text/rfc822-headers part), then the notice's
//     own Original-Message-ID / In-Reply-To / References headers. Only dazl's own ids on the sender's domain count
//     (dazl.<send>@, dazl.s<n>.<send>@, dazl.f<n>.<send>@, dazl.reopen.<send>@); ids naming two different sends are
//     ambiguous and correlate to nothing;
//   - the recipient: a per-recipient delivery-status block whose Final-Recipient or Original-Recipient is exactly
//     the address that send went to; or, only when the notice has no per-recipient block at all, the daemon's
//     X-Failed-Recipients naming it. A block naming someone else never correlates (it cannot cost another contact).
// The status of THAT recipient's block decides permanent (Action: failed + 5.x.x) vs soft; X-Failed-Recipients
// alone carries no status, so it is a review item, never an automatic suppression.
export interface DsnRecipientBlock { recipients: string[]; action: string | null; status: string | null }
export interface NoticeFields { refs: string[]; blocks: DsnRecipientBlock[]; xFailed: string[] }

const decodePart = (p?: GPart): string => { try { return p?.body?.data ? Buffer.from(p.body.data, 'base64url').toString('utf8') : '' } catch { return '' } }
const fieldBlocks = (text: string): Record<string, string>[] =>
  text.split(/\r?\n\s*\r?\n/).map(b => {
    const o: Record<string, string> = {}
    for (const line of b.split(/\r?\n/)) { const m = /^([A-Za-z-]+):\s*(.+)$/.exec(line.trim()); if (m) o[m[1].toLowerCase()] = m[2].trim() }
    return o
  }).filter(o => Object.keys(o).length > 0)
const typedAddr = (v?: string) => (v ? addr(v.replace(/^[a-z0-9-]+\s*;\s*/i, '')) : '')

export function noticeFields(payload: GPart | undefined): NoticeFields {
  const hv = (p: GPart | undefined, n: string) => p?.headers?.filter(h => h.name.toLowerCase() === n).map(h => h.value) ?? []
  const refs: string[] = []
  const blocks: DsnRecipientBlock[] = []
  const walk = (p: GPart | undefined, depth: number) => {
    if (!p || depth > 12) return
    const mime = (p.mimeType ?? '').toLowerCase()
    if (mime === 'message/delivery-status') {
      for (const b of fieldBlocks(decodePart(p))) {
        const recipients = [typedAddr(b['final-recipient']), typedAddr(b['original-recipient'])].filter(Boolean)
        if (recipients.length) blocks.push({ recipients, action: b['action']?.toLowerCase() ?? null, status: b['status'] ?? null })
      }
    } else if (mime === 'message/rfc822' || mime === 'text/rfc822-headers') {
      refs.push(...hv(p, 'message-id'))
      const text = decodePart(p)
      const head = text.split(/\r?\n\r?\n/, 1)[0] ?? ''
      const m = /^Message-ID:\s*(.+)$/im.exec(head)
      if (m) refs.push(m[1])
      for (const c of p.parts ?? []) refs.push(...hv(c, 'message-id')) // Gmail can expose the returned message as a nested part
    }
    for (const c of p.parts ?? []) walk(c, depth + 1)
  }
  walk(payload, 0)
  for (const n of ['original-message-id', 'in-reply-to', 'references']) refs.push(...hv(payload, n))
  const xFailed = hv(payload, 'x-failed-recipients').flatMap(v => v.split(',')).map(v => addr(v)).filter(Boolean)
  return { refs, blocks, xFailed }
}

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
// Used only by judgeDeliveryNotice below (the test-only inbox-fixture path, #369); the real sync (#415) uses
// noticeFields/dsnProvenance above instead.
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

// One delivery notice, judged by Message-ID + recipient correlation alone (no authenticated DSN provenance) and
// turned into the inbound_messages row it is stored as. Pure: the caller looks up the exact recorded send
// (NOTICE_SEND_SQL) and writes the row. Used only by the test-only inbox fixture (lib/outreach/inbox-fixture.ts,
// #369) to seed a bounce_review row for pagination/UI tests; the real reply sync below (#415) no longer calls this
// directly — it correlates by the notice's own structured fields (noticeFields) and additionally requires
// authenticated DSN provenance (dsnProvenance) before a correlated 5.x.x can suppress or stop anything, so a
// fixture row seeded here is a plausible bounce_review shape, not a byte-for-byte stand-in for real sync output.
export type NoticeMsg = GMsg
export interface NoticeSend { id: string; lead_id: string; to_email: string }
export interface NoticeRow { gmail_id: string; thread_id: string; lead_id: string | null; from_email: string; excerpt: string; classification: 'bounce_unmatched' | 'bounce_review' | 'soft_bounce'; received_at: number; outreach_message_id: string | null }
export interface NoticeVerdict { row: NoticeRow; unmatched: 'not_daemon' | 'no_correlation' | null; send: NoticeSend | null; status: string | null }
export const NOTICE_SEND_SQL = "SELECT id, lead_id, to_email FROM outreach_messages WHERE tenant_id = ? AND id = ? AND status IN ('sent','sending','uncertain')"
export const NOTICE_INSERT = '(gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at, outreach_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
export const noticeParams = (tenantId: string, r: NoticeRow): (string | number | null)[] =>
  [r.gmail_id, tenantId, r.thread_id, r.lead_id, r.from_email, r.excerpt, r.classification, r.received_at, r.outreach_message_id]
export function judgeDeliveryNotice(hitId: string, g: NoticeMsg, now: number, findSend: (refId: string) => NoticeSend | undefined): NoticeVerdict {
  const at = Math.floor(Number(g.internalDate ?? 0) / 1000) || now
  const from = addr(header(g, 'from'))
  // Retention minimum for anything that does not correlate to an exact recorded send: the opaque id (for
  // one-time accounting), the time and the classification. No sender, recipient or content of mail that may
  // not be ours - the read consent covers replies and delivery notices FOR OUR THREADS only.
  const unmatched = (why: 'not_daemon' | 'no_correlation'): NoticeVerdict => ({
    row: { gmail_id: hitId, thread_id: g.threadId ?? '', lead_id: null, from_email: '', excerpt: '', classification: 'bounce_unmatched', received_at: at, outreach_message_id: null },
    unmatched: why, send: null, status: null,
  })
  if (!/^(mailer-daemon|postmaster)@/.test(from)) return unmatched('not_daemon')
  const dsn = dsnFromNotice(g)
  // Correlate to the exact recorded send: the notice must reference our Message-ID AND name the recipient we
  // wrote to. BOTH, always: a From line matching mailer-daemon is not authentication (anyone can set it), so
  // no-reference notices - even genuine-looking 5.x.x ones naming a real sole recipient - can never suppress,
  // stop a thread or end a sequence. They are counted unmatched and left for review.
  // An exact Message-ID ref is CORRELATION, never authentication: a party who saw the send's headers could
  // quote it. Correlation alone therefore never suppresses and never stops anything: a 5.x.x that correlates
  // but cannot be PROVEN to come from the recipient's own mail infrastructure is classified bounce_review and
  // left for a human. Automatic suppression exists only behind authenticated DSN provenance.
  const refId = dsn.messageRef ? /dazl\.([a-z0-9]+)@/i.exec(dsn.messageRef)?.[1] ?? null : null
  let m: NoticeSend | undefined
  if (refId && dsn.recipient) m = findSend(refId) ?? undefined
  if (m && norm(m.to_email) !== dsn.recipient) m = undefined // the notice must name who we actually wrote to
  if (!m || !dsn.failed || !dsn.status) return unmatched('no_correlation')
  // A permanent failure WITHOUT authenticated provenance: review, never an automatic action. The notice
  // correlates to our send (exact ref + recipient), so it is not noise - but nothing about it proves the
  // recipient's mail infrastructure issued it, and unauthenticated mail must never suppress a contact or
  // stop a thread. 4.x.x and anything non-permanent: soft_bounce, never a suppression.
  const classification = /^5\.\d{1,3}\.\d{1,3}$/.test(dsn.status) ? 'bounce_review' : 'soft_bounce'
  return {
    row: { gmail_id: hitId, thread_id: g.threadId ?? '', lead_id: m.lead_id, from_email: from, excerpt: `dsn status ${dsn.status}`, classification, received_at: at, outreach_message_id: m.id },
    unmatched: null, send: m, status: dsn.status,
  }
}

// The recorded sends a notice's references name, on the tenant's own sending domain. Any dazl id form maps to the
// original send id (follow-ups and sequence steps carry the original's id).
export function referencedSendIds(refs: string[], senderDomain: string): string[] {
  const ids = new Set<string>()
  for (const r of refs) for (const m of r.matchAll(/<?dazl\.(?:(?:s|f)\d+\.|reopen\.)?([a-z0-9]+)@([^\s<>,;]+)>?/gi))
    if (m[2].toLowerCase() === senderDomain.toLowerCase()) ids.add(m[1])
  return [...ids]
}

// Origin evidence for a separate-thread notice (lib/outreach/dsn.ts dsnProvenance): the mailbox is read through the
// Gmail API, so the only receiving MX whose FIRST Authentication-Results is trusted is Google's; the authenticated
// domain must align with the recorded recipient's domain or its MX hosts (resolved by DNS at sync time, never taken
// from the notice). resolveMxFor is injectable for fixtures.
const TRUSTED_AUTHSERV_IDS = ['mx.google.com', 'google.com']
// node:dns/promises is loaded lazily so importing this module never needs a DNS module (route harnesses stub it).
const defaultResolveMx = async (domain: string): Promise<string[]> => {
  const { resolveMx } = await import('node:dns/promises')
  return (await resolveMx(domain)).map(r => r.exchange.toLowerCase())
}

export interface SyncDeps extends OAuthDeps { fetchImpl?: typeof fetch; clockMs?: () => number; resolveMxFor?: (domain: string) => Promise<string[]> }
// remaining: background threads (no automated send can reach them) not read this call because of the per-call cap or
// the time budget; they are read on later calls, oldest check first. neverRead: those of them never read at all (no
// freshness exists yet: the tick records a hold). freshAsOf: the OLDEST last-read time over every thread in scope after
// this call (a thread read now counts as now), i.e. the mailbox is known to be read as of then and no later; the tick
// records it as the reply-sync success time, so the 2-hour send-side gate (replySafetyStale) keeps meaning "every
// thread read within the last 2 hours", exactly as when every call read everything.
export interface SyncResult { threads: number; replies: number; optOuts: number; bounces: number; consents: number; reviews: number; remaining?: number; neverRead?: number; freshAsOf?: number; error?: string }

// #355: bounded, checkpointed reply reading. A tenant with a long sent history must not consume the serial tick before
// the next tenant gets its reply checks, and must not re-read its whole 120-day history every tick.
//   - SCOPE is the pre-#355 set, unchanged: sent in the last 120 days, or the step-1 message of an approved/active
//     sequence (any age). Pacing only changes the order and the cap, never which mailbox threads may be read.
//   - DUE threads are the ones an automated send can still reach: a step-1 message of an approved/active sequence (any
//     age), or, inside the 120-day window, a thread with a lead reply that follow-ups may answer (followup_threads not
//     stopped). They are ALWAYS read on every call, before anything else and outside the cap; if the time budget runs
//     out before every due thread is read, the call fails closed (error reply_sync_incomplete) and the caller sends
//     nothing for this tenant.
//   - BACKGROUND threads (sent in the last 120 days, no automated send pending) are read at most REPLY_SYNC_MAX_THREADS
//     per call (default 50, 1..1000), never-read first, then the oldest check first, so every one of them is read within
//     ceil(n / cap) calls. The rest are reported as `remaining`; while any thread in scope has never been read the tick
//     records a 'hold'; otherwise a success as of `freshAsOf`, the oldest read time (never "now" after a partial read).
//   - The whole call is bounded by REPLY_SYNC_BUDGET_MS (default 120000, 1000..600000); anything else is the default.
//   - outreach_messages.reply_checked_at is stamped only after a thread was read and processed without error; a failed
//     read keeps its old stamp, so it is first in line next time.
export const REPLY_SYNC_DEFAULT_MAX_THREADS = 50
export const REPLY_SYNC_DEFAULT_BUDGET_MS = 120_000
const boundedInt = (raw: unknown, def: number, min: number, max: number) => {
  if (typeof raw !== 'string' || !/^\d{1,7}$/.test(raw.trim())) return def
  const v = Number(raw.trim())
  return v >= min && v <= max ? v : def
}
export function replySyncLimits(env: Record<string, string | undefined> = process.env): { maxThreads: number; budgetMs: number } {
  return { maxThreads: boundedInt(env.REPLY_SYNC_MAX_THREADS, REPLY_SYNC_DEFAULT_MAX_THREADS, 1, 1000), budgetMs: boundedInt(env.REPLY_SYNC_BUDGET_MS, REPLY_SYNC_DEFAULT_BUDGET_MS, 1000, 600_000) }
}

export async function syncReplies(db: Database.Database, tenantId: string, d: SyncDeps = {}): Promise<SyncResult> {
  const out: SyncResult = { threads: 0, replies: 0, optOuts: 0, bounces: 0, consents: 0, reviews: 0 }
  const now = d.now ?? Math.floor(Date.now() / 1000)
  const acct = db.prepare('SELECT email, read_granted, status, refresh_ct FROM gmail_accounts WHERE tenant_id = ?').get(tenantId) as { email: string; read_granted: number; status: string; refresh_ct: string } | undefined
  if (!hasReadConsent(db, tenantId) || !acct || acct.read_granted !== 1 || acct.status !== 'active') return { ...out, error: 'reading_not_enabled' }
  // Read authority is re-proved (send-authority.ts recheckReadAuthority) after every await: before any further Gmail read and
  // before anything read is stored or granted from (#928). A revoked consent, replaced connection or unreadable check ends the sync.
  const LOST = Symbol('read_authority_lost') // a sentinel, not an error type: it never leaves this function
  const authority = () => { if (recheckReadAuthority(db, tenantId, { email: acct.email, refreshCt: acct.refresh_ct })) throw LOST }
  const f = d.fetchImpl ?? fetch
  let token: string
  try { token = await getAccessToken(db, tenantId, d) } catch { return { ...out, error: 'gmail_unavailable' } }
  if (recheckReadAuthority(db, tenantId, { email: acct.email, refreshCt: acct.refresh_ct })) return { ...out, error: 'reading_not_enabled' }
  if (gmailIsStubbed((d.env ?? process.env) as Record<string, string | undefined>)) return out // stubbed Gmail: no mailbox to read
  const get = async (path: string) => { authority(); const r = await f(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) }); if (!r.ok) throw new Error(`gmail_${r.status}`); const body = await r.json(); authority(); return body }

  const seq = tableExists(db, 'sequences') ? "id IN (SELECT message_id FROM sequences WHERE tenant_id = ? AND status IN ('approved','active'))" : '0'
  const warm = tableExists(db, 'followup_threads') ? '(thread_id IS NOT NULL AND thread_id IN (SELECT thread_id FROM followup_threads WHERE tenant_id = ? AND stopped IS NULL AND last_lead_reply_at IS NOT NULL))' : '0'
  const seqArgs = seq !== '0' ? [tenantId] : [], warmArgs = warm !== '0' ? [tenantId] : []
  const windowStart = now - 120 * 86400
  // The WHERE clause is the old selection (window OR approved/active sequence); the warm clause only orders threads
  // inside the window, so it can never pull an older thread into the read.
  const sent = db.prepare(`SELECT id, lead_id, to_email, gmail_id, thread_id, sent_at, reply_checked_at, CASE WHEN ${seq} OR (sent_at >= ? AND ${warm}) THEN 1 ELSE 0 END AS due FROM outreach_messages
    WHERE tenant_id = ? AND status = 'sent' AND gmail_id IS NOT NULL AND (sent_at >= ? OR ${seq})
    ORDER BY due DESC, reply_checked_at IS NOT NULL, reply_checked_at ASC, sent_at DESC`).all(...seqArgs, windowStart, ...warmArgs, tenantId, windowStart, ...seqArgs) as { id: string; lead_id: string; to_email: string; gmail_id: string; thread_id: string | null; sent_at: number; reply_checked_at: number | null; due: number }[]
  const { maxThreads, budgetMs } = replySyncLimits((d.env ?? process.env) as Record<string, string | undefined>)
  const clock = d.clockMs ?? Date.now
  const t0 = clock()
  let background = 0, remaining = 0, dueUnread = 0
  const skipBackground = () => { remaining++ }
  const readNow = new Set<string>()
  for (const m of sent) {
    if (clock() - t0 > budgetMs) { if (m.due) dueUnread++; else skipBackground(); continue }
    if (!m.due) { if (background >= maxThreads) { skipBackground(); continue } background++ }
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
          // Same bar as the separate-thread branch (#415/#928): a bounce is recorded ONLY from a structured delivery-status
          // block (action=failed, 5.x.x) naming the recipient we wrote to, behind authenticated provenance. A daemon-looking
          // From with a plain "5.1.1" body proves nothing: it is logged for review once per send, never suppresses or counts.
          const nf = noticeFields(g.payload)
          const key = norm(m.to_email)
          const block = nf.blocks.find(b => b.recipients.includes(key))
          const permanent = !!block && block.action === 'failed' && /^5\.\d{1,3}\.\d{1,3}$/.test(block.status ?? '')
          // A matched recipient block alone decides (delayed / 4.x.x stays soft); the plain-text fallback only applies with no block.
          const plain5xx = !block && /\b5\.\d{1,3}\.\d{1,3}\b/.test(fullText(g.payload))
          if (!permanent && !plain5xx) { log('soft_bounce'); continue }
          const review = (why: string) => {
            if (!db.prepare("SELECT 1 FROM inbound_messages WHERE tenant_id = ? AND outreach_message_id = ? AND classification = 'bounce_review'").get(tenantId, m.id)) {
              auditAt(db, tenantId, 'bounce_review', why, m.lead_id, m.id, now)
              out.reviews++
            }
            log('bounce_review')
          }
          if (!permanent) { review('same-thread 5.x.x without a structured delivery-status for the recipient, provenance unverified'); continue }
          const domain = key.split('@')[1] ?? ''
          const trust = (expected: string[]) => dsnProvenance(g.payload, { trustedAuthservIds: TRUSTED_AUTHSERV_IDS, expectedBounceDomains: expected })
          let prov = trust([domain])
          if (!prov.ok && prov.reason === 'domain_not_aligned') {
            const mx = await (d.resolveMxFor ?? defaultResolveMx)(domain).catch(() => [] as string[])
            authority()
            prov = trust([domain, ...mx])
          }
          if (!prov.ok) { review(`same-thread dsn ${block!.status} correlated, provenance unverified`); continue }
          // Accounted per send + recipient in the shared ledger: the same bounce also seen as a separate notice never counts twice.
          const r = applyBounceVerdict(db, tenantId, { kind: 'permanent', recipient: m.to_email, originalMessageId: root, outreachMessageId: m.id }, 'dsn', g.id, now)
          db.prepare("UPDATE followup_threads SET stopped = 'bounce' WHERE tenant_id = ? AND thread_id = ?").run(tenantId, thread)
          if (r === 'recorded') out.bounces++
          log('bounce')
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
      db.prepare('UPDATE outreach_messages SET reply_checked_at = ? WHERE id = ? AND tenant_id = ?').run(now, m.id, tenantId) // read and processed: checkpoint
      readNow.add(m.id)
    } catch (e) {
      if (e === LOST) return { ...out, error: 'reading_not_enabled' } // nothing more is read or stored
      out.error = 'reply_sync_failed' // fail closed: the scheduler must not treat a partial sync as fresh
      auditAt(db, tenantId, 'sync_error', e instanceof Error ? e.message : 'error', m.lead_id, m.id, now)
    }
  }
  if (remaining) out.remaining = remaining
  {
    let never = 0, oldest = now
    for (const m of sent) { const t = readNow.has(m.id) ? now : m.reply_checked_at; if (t === null) never++; else if (t < oldest) oldest = t }
    if (never) out.neverRead = never
    else if (oldest < now) out.freshAsOf = oldest // a full read is fresh as of now: the result is unchanged for it
  }
  // a thread an automated send can reach was not read: nothing may be sent on the strength of this call
  if (dueUnread && !out.error) { out.error = 'reply_sync_incomplete'; auditAt(db, tenantId, 'sync_error', `budget ${budgetMs} ms ran out with ${dueUnread} due thread(s) unread`, undefined, undefined, now) }
  // Phase 2 (#415): daemon notices on their own threads, correlated to the exact recorded send before anything is
  // suppressed. Window: since the last successful sync, never wider than 7 days (first sync: 2 days).
  try {
    const prev = tableExists(db, 'scheduler_progress') ? (db.prepare("SELECT last_success_at FROM scheduler_progress WHERE tenant_id = ? AND kind = 'reply_sync'").get(tenantId) as { last_success_at: number | null } | undefined)?.last_success_at : null
    const since = prev ? Math.max(prev, now - 7 * 86400) : now - 2 * 86400
    const q = encodeURIComponent(`from:mailer-daemon OR from:postmaster after:${since}`)
    const list = (await get(`messages?q=${q}&maxResults=50`)) as { messages?: { id: string }[] }
    const senderDomain = acct.email.split('@')[1] ?? ''
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
      // Correlate to the exact recorded send by the notice's own structured fields (see noticeFields), never by
      // thread: the notice must reference our Message-ID AND name the recipient we wrote to. BOTH, always: a From
      // line matching mailer-daemon is not authentication (anyone can set it), so no-reference notices - even
      // genuine-looking 5.x.x ones naming a real sole recipient - can never suppress, stop a thread or end a
      // sequence. They are counted unmatched.
      const nf = noticeFields(g.payload)
      const ids = referencedSendIds(nf.refs, senderDomain)
      let m: { id: string; lead_id: string; to_email: string } | undefined
      if (ids.length === 1) m = (db.prepare("SELECT id, lead_id, to_email FROM outreach_messages WHERE tenant_id = ? AND id = ? AND status IN ('sent','sending','uncertain')").get(tenantId, ids[0]) as typeof m) ?? undefined
      const block = m ? nf.blocks.find(b => b.recipients.includes(norm(m!.to_email))) : undefined
      const xFailedOnly = !!m && !block && nf.blocks.length === 0 && nf.xFailed.includes(norm(m.to_email))
      if (m && !block && !xFailedOnly) m = undefined // the notice must name who we actually wrote to
      const status = block?.status ?? null
      const log = (cls: string, mid: string | null, leadId: string | null) => db.prepare('INSERT OR IGNORE INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at, outreach_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(hit.id, tenantId, g.threadId ?? '', leadId, from, `dsn status ${status ?? (xFailedOnly ? 'x-failed-recipients' : 'none')}`, cls, at, mid)
      if (!m || (block && !status)) { // no correlation, or a block with no status: nothing structured to act on
        logUnmatched()
        auditAt(db, tenantId, 'bounce_unmatched', 'no exact send correlation', undefined, undefined, now)
        continue
      }
      const review = (why: string) => {
        // Correlated but not provable: a human review item, counted once per send; never an automatic action.
        if (!db.prepare("SELECT 1 FROM inbound_messages WHERE tenant_id = ? AND outreach_message_id = ? AND classification = 'bounce_review'").get(tenantId, m!.id)) {
          auditAt(db, tenantId, 'bounce_review', why, m!.lead_id, m!.id, now)
          out.reviews++
        }
        log('bounce_review', m!.id, m!.lead_id)
      }
      if (xFailedOnly) { review('x-failed-recipients correlated, no delivery-status, provenance unverified'); continue }
      if (block!.action !== 'failed' || !/^5\.\d{1,3}\.\d{1,3}$/.test(status!)) { log('soft_bounce', m.id, m.lead_id); continue } // 4.x.x / delayed: never a suppression
      // A correlated permanent failure acts ONLY behind authenticated provenance: the first Authentication-Results
      // is Google's receiving MX and its pass domain aligns with the recorded recipient's domain or its MX hosts.
      const domain = norm(m.to_email).split('@')[1] ?? ''
      const trust = (expected: string[]) => dsnProvenance(g.payload, { trustedAuthservIds: TRUSTED_AUTHSERV_IDS, expectedBounceDomains: expected })
      let prov = trust([domain])
      if (!prov.ok && prov.reason === 'domain_not_aligned') {
        const mx = await (d.resolveMxFor ?? defaultResolveMx)(domain).catch(() => [] as string[])
        if (recheckReadAuthority(db, tenantId, { email: acct.email, refreshCt: acct.refresh_ct })) return { ...out, error: 'reading_not_enabled' } // revoked or replaced during the lookup: no write
        prov = trust([domain, ...mx])
      }
      if (!prov.ok) { review(`dsn ${status} correlated, provenance unverified`); continue }
      const applied = applyBounceVerdict(db, tenantId, { kind: 'permanent', recipient: m.to_email, originalMessageId: ids[0], outreachMessageId: m.id }, 'dsn', hit.id, now)
      // the send's own outreach thread stops; suppress() (via recordBounce) already stopped the address's sequences
      db.prepare("UPDATE followup_threads SET stopped = 'bounce' WHERE tenant_id = ? AND root_message_id = ? AND (stopped IS NULL OR stopped = 'review')").run(tenantId, `dazl.${m.id}@${senderDomain}`)
      if (applied === 'recorded') out.bounces++
      log('bounce', m.id, m.lead_id)
    }
  } catch (e) {
    if (e === LOST) return { ...out, error: 'reading_not_enabled' }
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
