import { accountSendCount, ACCOUNT_SEND_CAP, anyUncertainSend, tableExists } from './send-budget.ts'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getMasterKey } from '../secrets.ts'
import { buildMime, EMAIL_RE, toBase64Url } from '../gmail/mime.ts'
import { GmailError, GmailSendError, getAccessToken, gmailSend, gmailStatus, type OAuthDeps } from '../gmail/oauth.ts'
import { norm } from './store.ts'

export const DAILY_CAP = Math.min(ACCOUNT_SEND_CAP, Number(process.env.OUTREACH_DAILY_CAP || 20))
export const SENDING_STALE_S = 10 * 60

// Personal mailbox providers: a published address there is not a business contact.
const CONSUMER = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.ca', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com'])

<<<<<<< HEAD
// Test mode (operator env OUTREACH_TEST_MODE=1, default OFF). The only thing it unlocks:
// drafts addressed to a consumer mailbox that the tenant explicitly entered in their own
// test-inbox allowlist. Real tenant sends to prospects are never affected - a prospect
// address is not on the tenant's test list, and with the env unset nothing changes at all.
export const testSendsEnabled = () => process.env.OUTREACH_TEST_MODE === '1'
=======
// Off by default. Only this operator-selected test tenant and this exact inbox qualify.
const TEST_INBOX = 'instinct114114@gmail.com'
export const testRecipientApproved = (db: Database.Database, tenantId: string, email: string): boolean =>
  !!process.env.OUTREACH_TEST_TENANT_ID && process.env.OUTREACH_TEST_TENANT_ID === tenantId &&
  norm(email) === TEST_INBOX && isAllowlistedTestRecipient(db,tenantId,email)
export const recipientAllowed = (db: Database.Database, tenantId: string, email: string): boolean =>
  !CONSUMER.has(norm(email).split('@')[1]) || testRecipientApproved(db,tenantId,email)
>>>>>>> origin/feat/test-only-send-route
// Mirrors sequences.ts testAddresses (that module owns the allowlist; read directly here to
// avoid a service -> sequences import cycle). Table may not exist on older databases.
const isAllowlistedTestRecipient = (db: Database.Database, tenantId: string, email: string): boolean => {
  if (!tableExists(db, 'sequence_settings')) return false
  const r = db.prepare('SELECT test_addresses FROM sequence_settings WHERE tenant_id = ?').get(tenantId) as { test_addresses: string } | undefined
  try { return (JSON.parse(r?.test_addresses ?? '[]') as string[]).map(norm).includes(norm(email)) } catch { return false }
}

export class OutreachError extends Error {
  code: string
  constructor(code: string) {
    super(code)
    this.code = code
  }
}

// Tenant-scoped, checked again after every async preparation before a send.
export function leadHeld(db: Database.Database, tenantId: string, leadId: string): boolean {
  return !!db.prepare('SELECT 1 FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ? AND l.fit = 0 AND l.intent IS NULL').get(leadId, tenantId)
}

export interface Deps extends OAuthDeps { baseUrl?: string; sendFn?: typeof gmailSend }
const nowS = (d: Deps) => d.now ?? Math.floor(Date.now() / 1000)
const baseUrl = (d: Deps) => (d.baseUrl ?? process.env.PUBLIC_BASE_URL ?? 'https://dazl.ai').replace(/\/$/, '')

// ---------- unsubscribe tokens ----------
const unsubKey = (master: Buffer) => createHmac('sha256', master).update('dazl-unsubscribe-v1').digest()
export function unsubToken(messageId: string, master = getMasterKey()): string {
  return `${messageId}.${createHmac('sha256', unsubKey(master)).update(messageId).digest('hex').slice(0, 32)}`
}
export function readUnsubToken(token: string, master = getMasterKey()): string | null {
  const [id, sig] = token.split('.')
  if (!id || !sig || !/^[a-f0-9]{24}$/.test(id) || !/^[a-f0-9]{32}$/.test(sig)) return null
  const want = unsubToken(id, master).split('.')[1]
  return timingSafeEqual(Buffer.from(sig), Buffer.from(want)) ? id : null
}

export function isSuppressed(db: Database.Database, tenantId: string, email: string): boolean {
  return !!db.prepare('SELECT 1 FROM suppressions WHERE tenant_id = ? AND email = ?').get(tenantId, norm(email))
}

export function suppress(db: Database.Database, tenantId: string, email: string, reason: 'unsubscribe' | 'manual' | 'bounce'): void {
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO suppressions (tenant_id, email, reason) VALUES (?, ?, ?)').run(tenantId, norm(email), reason)
    // an opt-out ends every kind of automated contact with this address
    try { db.prepare('UPDATE consent_ledger SET revoked_at = CAST(strftime(\'%s\',\'now\') AS INTEGER), revoke_reason = ? WHERE tenant_id = ? AND contact = ? AND revoked_at IS NULL').run(reason, tenantId, norm(email)) } catch { /* ledger not created yet */ }
    if (tableExists(db, 'sequences')) db.prepare("UPDATE sequences SET status = 'stopped', stop_reason = 'suppressed' WHERE tenant_id = ? AND to_email = ? AND status IN ('draft','approved','active')").run(tenantId,norm(email))
    // nothing waiting to go out to this address may go out
    db.prepare("UPDATE outreach_messages SET status = 'skipped', error = 'suppressed', approved_hash = NULL WHERE tenant_id = ? AND to_email = ? AND status IN ('draft','approved')").run(tenantId, norm(email))
  })()
}

// Public unsubscribe link: honored immediately, no login.
export function unsubscribeByToken(db: Database.Database, token: string, master = getMasterKey()): boolean {
  const id = readUnsubToken(token, master)
  if (!id) return false
  const m = db.prepare('SELECT tenant_id, to_email FROM outreach_messages WHERE id = ?').get(id) as { tenant_id: string; to_email: string } | undefined
  if (!m) return false
  suppress(db, m.tenant_id, m.to_email, 'unsubscribe')
  return true
}

// ---------- sender identity ----------
export interface Settings { sender_name: string; postal_address: string; booking_url?: string | null }
export function cleanBookingUrl(v: unknown): string {
  const u = String(v ?? '').trim()
  if (!u) return ''
  if (!/^https:\/\/\S{4,300}$/.test(u) || /[\s"'<>]/.test(u)) throw new OutreachError('bad_booking_url')
  return u
}
const ctl = /[\u0000-\u001f\u007f]/g
export function saveSettings(db: Database.Database, tenantId: string, s: Settings): void {
  const sender_name = s.sender_name.replace(ctl, ' ').trim()
  const postal_address = s.postal_address.replace(ctl, ' ').replace(/\s+/g, ' ').trim()
  if (sender_name.length < 1 || sender_name.length > 100) throw new OutreachError('bad_sender_name')
  if (postal_address.length < 10 || postal_address.length > 300) throw new OutreachError('bad_postal_address')
  const booking_url = cleanBookingUrl(s.booking_url)
  db.prepare('INSERT INTO outreach_settings (tenant_id, sender_name, postal_address, booking_url) VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id) DO UPDATE SET sender_name = excluded.sender_name, postal_address = excluded.postal_address, booking_url = excluded.booking_url').run(tenantId, sender_name, postal_address, booking_url || null)
}
export const getSettings = (db: Database.Database, tenantId: string) =>
  db.prepare('SELECT sender_name, postal_address, booking_url FROM outreach_settings WHERE tenant_id = ?').get(tenantId) as Settings | undefined

// ---------- drafts ----------
const hash = (to: string, subject: string, body: string) => createHash('sha256').update(JSON.stringify([to, subject, body])).digest('hex')
const id24 = () => randomBytes(12).toString('hex')

interface Lead { id: string; company: string; name: string; contact: string | null; signal: string; source_url: string; evidence_excerpt: string | null; confidence: number | null; fit: number | null; intent: number | null }

export function draftTemplate(lead: Lead, businessName: string): { subject: string; body: string } {
  const who = lead.name ? lead.name.split(' ')[0] : 'there'
  return {
    subject: `Quick question for ${lead.company || lead.name}`.slice(0, 150),
    body: `Hi ${who},\n\nI came across this about ${lead.company || lead.name}: ${lead.signal}\n(${lead.source_url})\n\nI run ${businessName}. If that is something you are working on, I'd be glad to share how we could help. Would a short call this week make sense?\n\nThanks,`,
  }
}

// A draft needs a lead that dazl verified (quote on the cited page, contact published
// on that page), a business email address, and no suppression.
export function createDraft(db: Database.Database, tenantId: string, leadId: string, businessName: string): string {
  const lead = db.prepare(
    `SELECT l.id, l.company, l.name, l.contact, l.signal, l.source_url, l.evidence_excerpt, l.confidence, l.fit, l.intent
     FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?`,
  ).get(leadId, tenantId) as Lead | undefined
  if (!lead) throw new OutreachError('not_found')
  if (!lead.evidence_excerpt || lead.confidence === null) throw new OutreachError('lead_not_verified')
  // Held lead: ICP grading failed, so it sits at fit 0 with intent unset. That hold is not a
  // grade, and the lead must not be emailed until a rescan grades it successfully. A real
  // grade of 0 (intent set) and never-scored leads (fit unset) are not affected.
  if (lead.fit === 0 && lead.intent === null) throw new OutreachError('lead_ungraded')
  // The address must be published: on the cited page (lead.contact) or on the company's own contact page (sitecrawl, with its source URL).
  let published = lead.contact ?? ''
  if (!EMAIL_RE.test(norm(published))) {
    try {
      const r = db.prepare("SELECT value FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = 'sitecrawl' AND kind = 'email' ORDER BY retrieved_at DESC LIMIT 1").get(lead.id, tenantId) as { value: string } | undefined
      if (r) published = r.value
    } catch { /* enrichment table not present */ }
  }
  const to = norm(published)
  if (!EMAIL_RE.test(to)) throw new OutreachError('no_email_contact')
<<<<<<< HEAD
  const test = isAllowlistedTestRecipient(db, tenantId, to) ? 1 : 0
  if (CONSUMER.has(to.split('@')[1]) && !(test === 1 && testSendsEnabled())) throw new OutreachError('personal_email')
=======
  const test = testRecipientApproved(db, tenantId, to) ? 1 : 0
  if (!recipientAllowed(db,tenantId,to)) throw new OutreachError('personal_email')
>>>>>>> origin/feat/test-only-send-route
  if (isSuppressed(db, tenantId, to)) throw new OutreachError('suppressed')
  const t = draftTemplate(lead, businessName)
  const id = id24()
  try {
    db.prepare('INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, test) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, tenantId, lead.id, to, t.subject, t.body, test)
  } catch {
    throw new OutreachError('already_drafted')
  }
  return id
}

interface Msg { id: string; tenant_id: string; lead_id: string; to_email: string; subject: string; body: string; status: string; approved_hash: string | null; attempts: number; claimed_at: number | null; sent_at: number | null; error: string | null; created_at: number; test: number }
const getMsg = (db: Database.Database, tenantId: string, id: string) =>
  db.prepare('SELECT * FROM outreach_messages WHERE id = ? AND tenant_id = ?').get(id, tenantId) as Msg | undefined

export function listMessages(db: Database.Database, tenantId: string, d: Deps = {}) {
  reapSending(db, d)
  return db.prepare('SELECT id, lead_id, to_email, subject, body, status, error, created_at, sent_at, test FROM outreach_messages WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200').all(tenantId)
}

const cleanLine = (s: string) => s.replace(/[\r\n\u0000]+/g, ' ').trim()

// Editing anything after approval drops the approval: what was approved is what is sent.
export function editDraft(db: Database.Database, tenantId: string, id: string, edit: { subject: string; body: string }): void {
  const m = getMsg(db, tenantId, id)
  if (!m) throw new OutreachError('not_found')
  if (m.status !== 'draft' && m.status !== 'approved') throw new OutreachError('not_editable')
  const subject = cleanLine(edit.subject)
  const body = edit.body.replace(/\u0000/g, '').trim()
  if (subject.length < 1 || subject.length > 150) throw new OutreachError('bad_subject')
  if (body.length < 20 || body.length > 3000) throw new OutreachError('bad_body')
  db.prepare("UPDATE outreach_messages SET subject = ?, body = ?, status = 'draft', approved_hash = NULL, error = NULL WHERE id = ? AND tenant_id = ? AND status IN ('draft','approved')").run(subject, body, id, tenantId)
  if (tableExists(db, 'sequences')) {
    const seq = db.prepare('SELECT id FROM sequences WHERE tenant_id = ? AND message_id = ?').get(tenantId,id) as { id: string } | undefined
    if (seq) {
      db.prepare("UPDATE sequences SET status = 'draft' WHERE id = ? AND tenant_id = ? AND status IN ('draft','approved')").run(seq.id,tenantId)
      db.prepare("UPDATE sequence_steps SET approved_hash = NULL, status = 'draft' WHERE sequence_id = ? AND tenant_id = ? AND status IN ('draft','approved')").run(seq.id,tenantId)
      db.prepare('UPDATE sequence_steps SET subject = ?, body = ? WHERE sequence_id = ? AND tenant_id = ? AND step = 1').run(subject,body,seq.id,tenantId)
    }
  }
}

export function skip(db: Database.Database, tenantId: string, id: string): void {
  const r = db.prepare("UPDATE outreach_messages SET status = 'skipped', approved_hash = NULL WHERE id = ? AND tenant_id = ? AND status IN ('draft','approved')").run(id, tenantId)
  if (r.changes !== 1) throw new OutreachError(getMsg(db, tenantId, id) ? 'not_skippable' : 'not_found')
}

export function approve(db: Database.Database, tenantId: string, id: string, sequenceSet = false): void {
  if (!sequenceSet && tableExists(db, 'sequences') && db.prepare("SELECT 1 FROM sequences WHERE tenant_id = ? AND message_id = ? AND status NOT IN ('stopped','done')").get(tenantId, id)) throw new OutreachError('approve_sequence_set')
  const m = getMsg(db, tenantId, id)
  if (!m) throw new OutreachError('not_found')
  if (m.status !== 'draft') throw new OutreachError('not_a_draft')
  if (!getSettings(db, tenantId)) throw new OutreachError('sender_identity_missing')
  if (gmailStatus(db, tenantId)?.status !== 'active') throw new OutreachError('gmail_not_connected')
  if (isSuppressed(db, tenantId, m.to_email)) throw new OutreachError('suppressed')
  db.prepare("UPDATE outreach_messages SET status = 'approved', approved_hash = ? WHERE id = ? AND tenant_id = ? AND status = 'draft'").run(hash(m.to_email, m.subject, m.body), id, tenantId)
}

// A claim that never finished may or may not have reached Gmail. It is never resent
// automatically: the user decides (resolveUncertain).
export function reapSending(db: Database.Database, d: Deps = {}): void {
  db.prepare("UPDATE outreach_messages SET status = 'uncertain', error = 'send_interrupted' WHERE status = 'sending' AND claimed_at < ?").run(nowS(d) - SENDING_STALE_S)
}

export function resolveUncertain(db: Database.Database, tenantId: string, id: string, as: 'sent' | 'retry', d: Deps = {}): void {
  const m = getMsg(db, tenantId, id)
  if (!m) throw new OutreachError('not_found')
  if (m.status !== 'uncertain') throw new OutreachError('not_uncertain')
  if (as === 'sent') db.prepare("UPDATE outreach_messages SET status = 'sent', sent_at = ?, error = NULL WHERE id = ? AND status = 'uncertain'").run(nowS(d), id)
  else db.prepare("UPDATE outreach_messages SET status = 'approved', error = NULL WHERE id = ? AND status = 'uncertain'").run(id) // approved_hash is still checked at send
}

export function composeBody(body: string, s: Settings, unsubUrl: string): string {
  return `${body.trim()}\n\n--\n${s.sender_name}\n${s.postal_address}\n\nIf you would rather not get emails like this, unsubscribe here: ${unsubUrl}\n`
}

export function sentLast24h(db: Database.Database, tenantId: string, d: Deps = {}): number {
  return (db.prepare("SELECT count(*) AS n FROM outreach_messages WHERE tenant_id = ? AND status IN ('sent','sending','uncertain') AND claimed_at >= ?").get(tenantId, nowS(d) - 86400) as { n: number }).n
}

// At most once. The claim is a single conditional UPDATE, so two concurrent or repeated
// calls cannot both send. Suppression, approval hash, sender identity, account health and
// the daily cap are all re-checked after the claim and before anything leaves.
export async function sendMessage(db: Database.Database, tenantId: string, id: string, d: Deps = {}): Promise<'sent' | 'uncertain'> {
  reapSending(db, d)
  const pre = getMsg(db, tenantId, id)
  if (!pre) throw new OutreachError('not_found')
  if (pre.status === 'sent') return 'sent' // idempotent retry
<<<<<<< HEAD
=======
  if (!recipientAllowed(db,tenantId,pre.to_email)) throw new OutreachError('personal_email')
>>>>>>> origin/feat/test-only-send-route
  if (leadHeld(db, tenantId, pre.lead_id)) throw new OutreachError('lead_ungraded')
  if (anyUncertainSend(db, tenantId)) throw new OutreachError('already_uncertain')
  if (tableExists(db, 'autopilot_settings') && (db.prepare('SELECT paused FROM autopilot_settings WHERE tenant_id = ?').get(tenantId) as { paused: number } | undefined)?.paused) throw new OutreachError('paused')
  if (pre.status !== 'approved') throw new OutreachError(pre.status === 'sending' || pre.status === 'uncertain' ? `already_${pre.status}` : 'not_approved')

  const claim = db.prepare("UPDATE outreach_messages SET status = 'sending', attempts = attempts + 1, claimed_at = ?, error = NULL WHERE id = ? AND tenant_id = ? AND status = 'approved'").run(nowS(d), id, tenantId)
  if (claim.changes !== 1) throw new OutreachError('already_sending')
  const release = (code: string): never => {
    db.prepare("UPDATE outreach_messages SET status = 'approved', claimed_at = NULL, error = ? WHERE id = ? AND status = 'sending'").run(code, id)
    throw new OutreachError(code)
  }
  const m = getMsg(db, tenantId, id)!
  if (isSuppressed(db, tenantId, m.to_email)) {
    db.prepare("UPDATE outreach_messages SET status = 'skipped', error = 'suppressed', approved_hash = NULL, claimed_at = NULL WHERE id = ?").run(id)
    throw new OutreachError('suppressed')
  }
  if (m.approved_hash !== hash(m.to_email, m.subject, m.body)) release('changed_since_approval')
  if (tableExists(db, 'sequences')) {
    const seq = db.prepare("SELECT id,status FROM sequences WHERE tenant_id = ? AND message_id = ?").get(tenantId,id) as { id: string; status: string } | undefined
    if (seq && (seq.status !== 'approved' || db.prepare("SELECT 1 FROM sequence_steps WHERE tenant_id = ? AND sequence_id = ? AND (status <> 'approved' OR approved_hash IS NULL)").get(tenantId,seq.id))) release('approve_sequence_set')
    if (seq) {
      const steps = db.prepare('SELECT step,subject,body,approved_hash FROM sequence_steps WHERE tenant_id = ? AND sequence_id = ?').all(tenantId,seq.id) as {step:number;subject:string;body:string;approved_hash:string}[]
      if (steps.length !== 3 || steps.some(st => st.approved_hash !== hash(m.to_email,st.subject,st.body)) || !steps.some(st => st.step === 1 && st.subject === m.subject && st.body === m.body)) release('changed_since_approval')
    }
  }
  const settings = getSettings(db, tenantId)
  if (!settings) release('sender_identity_missing')
  const acct = db.prepare('SELECT email FROM gmail_accounts WHERE tenant_id = ?').get(tenantId) as { email: string } | undefined
  if (!acct) release('gmail_not_connected')
  if (accountSendCount(db, tenantId, nowS(d)) > DAILY_CAP) release('daily_cap') // this claim counts itself

  let token: string
  try {
    token = await getAccessToken(db, tenantId, d)
  } catch (e) {
    return release(e instanceof GmailError && e.kind === 'reconnect' ? 'gmail_reconnect_needed' : 'gmail_unavailable')
  }

  // Token refresh is asynchronous. Recheck authorization and suppression after it,
  // immediately before handing the immutable MIME bytes to Gmail.
<<<<<<< HEAD
=======
  if (!recipientAllowed(db,tenantId,m.to_email)) release('personal_email')
>>>>>>> origin/feat/test-only-send-route
  if (leadHeld(db,tenantId,m.lead_id)) release('lead_ungraded')
  if (isSuppressed(db,tenantId,m.to_email)) release('suppressed')
  const final = getMsg(db,tenantId,id)!
  if (final.approved_hash !== hash(final.to_email,final.subject,final.body) || final.body !== m.body || final.subject !== m.subject || final.to_email !== m.to_email) release('changed_since_approval')
  if (tableExists(db,'sequences')) {
    const set = db.prepare('SELECT status FROM sequences WHERE tenant_id = ? AND message_id = ?').get(tenantId,id) as {status:string} | undefined
    if (set && set.status !== 'approved') release('approve_sequence_set')
  }
  if (tableExists(db,'autopilot_settings') && (db.prepare('SELECT paused FROM autopilot_settings WHERE tenant_id = ?').get(tenantId) as {paused:number}|undefined)?.paused) release('paused')
  const master = d.master ?? getMasterKey()
  const unsubUrl = `${baseUrl(d)}/api/unsubscribe?t=${unsubToken(id, master)}`
  const raw = toBase64Url(buildMime({
    fromName: settings!.sender_name, fromEmail: acct!.email, to: m.to_email, subject: m.subject,
    body: composeBody(m.body, settings!, unsubUrl), messageId: `dazl.${id}@${acct!.email.split('@')[1]}`, unsubscribeUrl: unsubUrl, date: new Date(nowS(d) * 1000),
  }))
  try {
    const out = await (d.sendFn ?? gmailSend)(token, raw, d.fetchImpl)
    if (m.test) console.log('outreach TEST MODE send', id, m.to_email)
    db.prepare("UPDATE outreach_messages SET status = 'sent', sent_at = ?, gmail_id = ?, thread_id = ?, error = NULL WHERE id = ? AND status = 'sending'").run(nowS(d), out.id, (out as { threadId?: string }).threadId ?? null, id)
    return 'sent'
  } catch (e) {
    if (e instanceof GmailSendError) {
      // Gmail refused before accepting the message: safe to put back.
      if (e.status === 401 || e.status === 403) {
        db.prepare("UPDATE gmail_accounts SET status = 'needs_reconnect' WHERE tenant_id = ?").run(tenantId)
        return release('gmail_reconnect_needed')
      }
      if (e.status === 400 || e.status === 404) return release('gmail_rejected')
      if (e.status === 429) return release('gmail_rate_limited')
    }
    // Network error, timeout or 5xx: the message may have gone out. Do not retry blindly.
    db.prepare("UPDATE outreach_messages SET status = 'uncertain', error = 'send_outcome_unknown' WHERE id = ? AND status = 'sending'").run(id)
    if (tableExists(db,'autopilot_settings')) db.prepare("UPDATE autopilot_settings SET paused = 1, pause_reason = 'uncertain_send' WHERE tenant_id = ?").run(tenantId)
    return 'uncertain'
  }
}
