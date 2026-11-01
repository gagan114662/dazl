import {contactPurposeRestricted} from './contact-purpose-db.ts'
import { evidenceStateOf, type EvidenceState } from './evidence-state.ts'
import {currentnessHeld} from './currentness.ts'
import {requiredGateHeld} from '../scan/held-state.ts'
import { messageProvenance } from './provenance.ts'
import { snapshotSignalContext } from './attribution.ts'
import { accountSendCount, ACCOUNT_SEND_CAP, anyUncertainSend, tableExists } from './send-budget.ts'
import { conversionBlockedNow } from './lifecycle.ts'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getMasterKey } from '../secrets.ts'
import { captureError } from '../ops/errors.ts'
import { buildMime, EMAIL_RE, toBase64Url } from '../gmail/mime.ts'
import { GmailError, GmailSendError, confirmedSendResult, getAccessToken, gmailSend, gmailStatus, type OAuthDeps } from '../gmail/oauth.ts'
import { norm, replySafetyStale } from './store.ts'
import { domainReviewFor } from './domain-review.ts'
import { pickCrawledEmail } from './published-email.ts'
import { isQuarantined } from '../scan/quarantine.ts'
import { isMissingSchema, draftOffer } from '../scan/play-offer-text.ts'
import { readTenantOffer } from './play-memory.ts'

export const DAILY_CAP = Math.min(ACCOUNT_SEND_CAP, Number(process.env.OUTREACH_DAILY_CAP || 20))
export const SENDING_STALE_S = 10 * 60

// Personal mailbox providers: a published address there is not a business contact.
const CONSUMER = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.ca', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com'])

// Off by default. Only the env-designated test tenant (OUTREACH_TEST_TENANT_ID) and this exact
// inbox qualify. This is a code gate only, not evidence of user permission.
export const TEST_INBOX = 'instinct114114@gmail.com'
export const testRecipientApproved = (db: Database.Database, tenantId: string, email: string): boolean =>
  !!process.env.OUTREACH_TEST_TENANT_ID && process.env.OUTREACH_TEST_TENANT_ID === tenantId &&
  norm(email) === TEST_INBOX && isAllowlistedTestRecipient(db,tenantId,email)
export const recipientAllowed = (db: Database.Database, tenantId: string, email: string): boolean =>
  !CONSUMER.has(norm(email).split('@')[1]) || testRecipientApproved(db,tenantId,email)
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

// Evidence eligibility, re-checked at every approval and every send. A draft or sequence
// created under a human confirmation is approvable/sendable only while that confirmation
// (or dazl's own verification) still stands: withdrawing the confirmation revokes the
// eligibility that backed it, and an exact-word approval hash is not a substitute.
// Machine-verified leads are unaffected. Tenant-scoped like every other lead read.
export type { EvidenceState } from './evidence-state.ts'
export function leadEvidenceState(db: Database.Database, tenantId: string, leadId: string): EvidenceState {
  const l = db.prepare('SELECT l.evidence_excerpt, l.confidence, l.human_confirmed_at FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?').get(leadId, tenantId) as { evidence_excerpt: string | null; confidence: number | null; human_confirmed_at: number | null } | undefined
  return l ? evidenceStateOf(l) : 'unverified'
}
export function leadEvidenceEligible(db: Database.Database, tenantId: string, leadId: string): boolean {
  return leadEvidenceState(db, tenantId, leadId) !== 'unverified'
}

// Server-created test material (test = 1) addressed to the currently allowlisted,
// env-designated test inbox is exempt from the evidence gate: it is a labelled
// demonstration to the operator's own inbox, never a real prospect. This exemption is a
// code gate only, not evidence of user permission. Like test timing, it is re-derived
// from the live allowlist at every action, never stored.
export const testFixtureSend = (db: Database.Database, tenantId: string, m: { to_email: string; test: number }): boolean =>
  m.test === 1 && testRecipientApproved(db, tenantId, m.to_email)

// expectSender: the Gmail address the caller authorized this send from (autopilot's held drafts); the send is refused
// (sender_changed) unless the connected account is that address at the moment the message is handed to Gmail.
// authorize: the caller's own authority, re-read synchronously as the last check before the message is handed to Gmail
// (after every await of the send path); a returned code refuses the send, known not sent. Autopilot passes one (on,
// not paused, current consent, operator flag, its reserved slot); a manual send passes none and is unchanged.
export interface Deps extends OAuthDeps { baseUrl?: string; sendFn?: typeof gmailSend; expectSender?: string; authorize?: () => string | null }
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

interface Lead { id: string; company: string; name: string; contact: string | null; signal: string; source_url: string; evidence_excerpt: string | null; confidence: number | null; fit: number | null; intent: number | null; human_confirmed_at: number | null }

export function draftTemplate(lead: Lead, businessName: string, positioning = '', addressUrl: string = lead.source_url): { subject: string; body: string } {
  // Literal seller-authored context only: never infer an offer from a buyer signal.
  // Keep this template-only, so a useful offer does not require paid AI polishing.
  const offer = positioning.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600)
  const name=businessName.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,150)
  if(!name)throw new OutreachError('seller_context_required')
  if(!offer)throw new OutreachError('seller_offer_required')
  const seller = `About ${name}: ${offer}`
  const who = lead.name ? lead.name.split(' ')[0] : 'there'
  // Only facts the user already holds: the seller's own offer and the page the address came from.
  // No guessed pain, no claimed buying need, no personal detail the page did not publish.
  // Separate source context (never address provenance): the saved source quote and its page, only when that page is not
  // the address page already cited. It says where the quote was seen, never what it means (no need, intent or fit claim).
  const full = (lead.evidence_excerpt ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  // Cut at a word boundary and say so, so a quoted prefix is never presented as the whole excerpt.
  const cutAt = full.lastIndexOf(' ', 160)
  const quote = full.length <= 160 ? full : `${full.slice(0, cutAt > 80 ? cutAt : 160).trimEnd()}...`
  // Saved text: nothing is refetched at draft time, so the label says so.
  const seen = quote && lead.source_url && lead.source_url !== addressUrl ? `\n\nSaved excerpt from this public page: "${quote}"\n${lead.source_url}` : ''
  return {
    subject: `Quick question for ${lead.company || lead.name}`.slice(0, 150),
    body: `Hi ${who},\n\nI'm writing to the contact address published on ${lead.company || 'your company'}'s page:\n${addressUrl}${seen}\n\n${seller}\n\nWould a short conversation about whether this fits your team's work be useful? If I have the wrong person, could you point me to the right one?\n\nThanks,`,
  }
}

// A draft needs a lead that dazl verified (quote on the cited page, contact published
// on that page), a business email address, and no suppression.
// One IMMEDIATE transaction around the gate reads and the insert (all synchronous, no network or model call inside): the write lock is
// taken before the lead, enrichment and identity-review rows are read, so a concurrent confirm, withdraw or crawl write on the same
// SQLite file cannot land between the identity gate and the draft insert. A thrown OutreachError rolls back nothing, since nothing was written yet.
type CrawledRows = NonNullable<Parameters<typeof domainReviewFor>[1]>
// The crawled address and domain evidence plus the user's domain review for one lead. Shared by the draft entry and the
// approve and send checks so all three read the same rows.
function readCrawledRows(db: Database.Database, tenantId: string, leadId: string): CrawledRows {
  return db.prepare("SELECT connector, kind, value, label, source_url, retrieved_at FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND ((connector = 'sitecrawl' AND kind IN ('email','domain')) OR (connector = 'user' AND kind = 'domain_review'))").all(leadId, tenantId) as CrawledRows
}
// True when the lead's address came from a crawl whose website still needs the user's identity review (never recorded, or withdrawn
// after the draft was made). A draft made before this check existed, or whose confirmation was later withdrawn, cannot be approved or sent.
export type DomainReviewStatus = 'ok' | 'required' | 'unreadable' | 'quarantined'
export function domainReviewStatus(db: Database.Database, tenantId: string, leadId: string, recipient: string): DomainReviewStatus {
  const lead = db.prepare('SELECT l.id, l.contact FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?').get(leadId, tenantId) as { id: string; contact: string | null } | undefined
  if (!lead) return 'ok'
  // A quarantined lead (scan/quarantine.ts) is held at every send path that passes through this gate. An unreadable
  // quarantine state (older schema, read error) is held too: never sent on an unknown.
  try { if (isQuarantined(db, leadId)) return 'quarantined' } catch { return 'unreadable' }
  let rows: CrawledRows
  // If the crawl state cannot be read (table missing or a read error) where the address came from is unknowable: held, for every lead.
  // This is a retryable fault, not something the user can fix by confirming a website.
  try { rows = readCrawledRows(db, tenantId, leadId) } catch { return 'unreadable' }
  if (EMAIL_RE.test(norm(lead.contact ?? ''))) {
    // The recipient is judged only when the lead's own crawl recorded it. A recipient with no crawl record has another source
    // (the cited page) and stays outside this gate. The message's recipient and words are never rewritten. Equality with the
    // lead's contact is not treated as proof of a cited-page origin: when the crawl also recorded the address, the review applies.
    const crawled = rows.some(r => r.connector === 'sitecrawl' && r.kind === 'email' && norm(r.value) === norm(recipient))
    if (!crawled) return 'ok'
    return domainReviewFor({ id: lead.id, contact: null }, rows).state === 'required' ? 'required' : 'ok'
  }
  return domainReviewFor({ id: lead.id, contact: lead.contact }, rows).state === 'required' ? 'required' : 'ok'
}
export const domainReviewHeld = (db: Database.Database, tenantId: string, leadId: string, recipient: string): boolean => domainReviewStatus(db, tenantId, leadId, recipient) !== 'ok'
// The error code for a held message: a missing review is something the user can act on, an unreadable state is a retry.
export const domainHoldCode = (db: Database.Database, tenantId: string, leadId: string, recipient: string): 'domain_unconfirmed' | 'review_unreadable' | 'lead_quarantined' => {
  const s = domainReviewStatus(db, tenantId, leadId, recipient)
  return s === 'quarantined' ? 'lead_quarantined' : s === 'unreadable' ? 'review_unreadable' : 'domain_unconfirmed'
}

export function createDraft(db: Database.Database, tenantId: string, leadId: string, businessName: string): string {
  return db.transaction(() => createDraftInner(db, tenantId, leadId, businessName)).immediate()
}

// Every check createDraft makes before it writes, in the same order. Throws OutreachError on the first refusal.
function draftChecks(db: Database.Database, tenantId: string, leadId: string) {
  const lead = db.prepare(
    `SELECT l.id, l.company, l.name, l.contact, l.signal, l.source_url, l.evidence_excerpt, l.confidence, l.fit, l.intent, l.human_confirmed_at
     FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?`,
  ).get(leadId, tenantId) as Lead | undefined
  if (!lead) throw new OutreachError('not_found')
  if (isQuarantined(db, leadId)) throw new OutreachError('lead_quarantined')
  if (requiredGateHeld(db,tenantId,leadId)) throw new OutreachError('sales_hiring_check_failed')   // confirming the lead or its domain never clears a failed required check
  if (currentnessHeld(db,tenantId,leadId)) throw new OutreachError('lead_currentness_unconfirmed')
  // Verified by dazl (quote confirmed on the cited page) OR confirmed by the user
  // themselves from the needs-review list. A human confirmation is the user's own
  // checked decision, labelled as such in the UI; it never rewrites the machine verdict.
  if (evidenceStateOf(lead) === 'unverified') throw new OutreachError('lead_not_verified')
  // Held lead: ICP grading failed, so it sits at fit 0 with intent unset. That hold is not a
  // grade, and the lead must not be emailed until a rescan grades it successfully. A real
  // grade of 0 (intent set) and never-scored leads (fit unset) are not affected.
  if (lead.fit === 0 && lead.intent === null) throw new OutreachError('lead_ungraded')
  // The address must be published: on the cited page (lead.contact) or on the company's own contact page (sitecrawl, with its source URL).
  let published = lead.contact ?? ''
  let crawled: NonNullable<Parameters<typeof domainReviewFor>[1]> = []
  // The page that actually shows the address: the cited page for a direct contact, the company's own
  // contact page (its stored source URL) for a sitecrawl address. Never the signal/news URL for a crawled address.
  let addressUrl = lead.source_url
  // The crawled rows are read even when the contact is already an email: equality with the contact does not prove the
  // cited page printed it, and domainReviewFor must see the crawl record of that address (approve/send already do via
  // domainReviewStatus; draft used to skip it, found by the card-vs-gate consistency test).
  const contactIsEmail = EMAIL_RE.test(norm(published))
  try {
    crawled = readCrawledRows(db, tenantId, lead.id)
    const r = pickCrawledEmail(crawled)
    if (r && !contactIsEmail) { published = r.value; addressUrl = r.source_url ?? lead.source_url }
    // A contact that equals a crawled address is not proof the cited page printed it: cite the page the crawler actually
    // saved for that address (the table keeps one record per address), never the signal/news URL. The recipient and the
    // identity rules are unchanged. A contact the crawl never recorded keeps the cited page.
    if (contactIsEmail) {
      const same = crawled.find(x => x.connector === 'sitecrawl' && x.kind === 'email' && norm(x.value) === norm(published) && x.source_url)
      if (same?.source_url) addressUrl = same.source_url
    }
  } catch { /* enrichment table not present */ }
  const to = norm(published)
  if (!EMAIL_RE.test(to)) throw new OutreachError('no_email_contact')
  // Published is not the same as sales-contactable: press, support, privacy,
  // careers and similar inboxes exist for another purpose. Never aim a sales
  // draft at them - the UI applies this same classification before offering a draft.
  if (contactPurposeRestricted(db,tenantId,leadId,to)) throw new OutreachError('not_sales_contact')
  // A crawled address whose website rests only on a name match or a link needs the user's identity review first (see domain-review.ts).
  // This is the single draft entry for the API and for autopilot, so neither can skip it. An address printed on the cited page is unaffected.
  if (domainReviewFor({ id: lead.id, contact: lead.contact }, crawled).state === 'required') throw new OutreachError('domain_unconfirmed')
  const test = testRecipientApproved(db, tenantId, to) ? 1 : 0
  if (!recipientAllowed(db,tenantId,to)) throw new OutreachError('personal_email')
  if (isSuppressed(db, tenantId, to)) throw new OutreachError('suppressed')
  return { lead, to, addressUrl, test }
}

// Read-only: why createDraft would refuse this lead right now (its error code), or null if it would accept it. Runs the
// very same checks (draftChecks); used by views that recommend a next step, so they never recommend a refused one.
export function draftBlockReason(db: Database.Database, tenantId: string, leadId: string): string | null {
  try { draftChecks(db, tenantId, leadId); return null } catch (e) { if (e instanceof OutreachError) return e.code; throw e }
}

// The play a lead came from, with what is needed to resolve its offer. null: no play of this tenant for the lead, or an
// older database without the columns. Any other read failure throws: an unreadable play is never "no play", so the
// caller never falls back to the tenant-wide offer.
export function playOfferRow(db: Database.Database, tenantId: string, leadId: string): { offer: string | null; seller: string | null; query: string | null } | null {
  try {
    return (db.prepare('SELECT j.offer, j.seller, j.query FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?').get(leadId, tenantId) as { offer: string | null; seller: string | null; query: string | null } | undefined) ?? null
  } catch (e) { if (isMissingSchema(e)) return null; throw e }
}

function createDraftInner(db: Database.Database, tenantId: string, leadId: string, businessName: string): string {
  const { lead, to, addressUrl, test } = draftChecks(db, tenantId, leadId)
  // What this lead's play sells (lib/scan/play-offer-text.ts draftOffer): the offer reviewed for the play, else the one
  // it was created with, else the tenant's own context: the Memory positioning or, after onboarding only, the profile
  // offer (users.sells), so nobody needs a second hidden form to explain their offer. No default offer is fabricated,
  // a website alone is not an offer, and another tenant's context is never used. A contested play (offer_conflict) gets
  // no draft until the tenant chooses.
  let play: ReturnType<typeof playOfferRow>, tenant: ReturnType<typeof readTenantOffer>
  try { play = playOfferRow(db, tenantId, lead.id); tenant = readTenantOffer(db, tenantId) } catch { throw new OutreachError('offer_unreadable') } // nothing drafted
  const r = draftOffer(play, tenant)
  if (r.refuse) throw new OutreachError(r.refuse)
  const positioning = r.offer ?? ''
  const t = draftTemplate(lead, businessName, positioning, addressUrl)
  const id = id24()
  try {
    db.prepare('INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, test) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, tenantId, lead.id, to, t.subject, t.body, test)
  } catch (e) {
    // Only the (tenant_id, lead_id) uniqueness means "already drafted". Any other failure (SQLITE_BUSY under a second
    // writer, a CHECK or other constraint) is not a duplicate and must not be reported as one.
    const code = (e as { code?: string }).code
    if (code === 'SQLITE_CONSTRAINT_UNIQUE' && /outreach_messages\.lead_id/.test(String((e as Error).message))) throw new OutreachError('already_drafted')
    throw e
  }
  return id
}

interface Msg { id: string; tenant_id: string; lead_id: string; to_email: string; subject: string; body: string; status: string; approved_hash: string | null; attempts: number; claimed_at: number | null; sent_at: number | null; error: string | null; created_at: number; test: number }
const getMsg = (db: Database.Database, tenantId: string, id: string) =>
  db.prepare('SELECT * FROM outreach_messages WHERE id = ? AND tenant_id = ?').get(id, tenantId) as Msg | undefined

export function listMessages(db: Database.Database, tenantId: string, d: Deps = {}) {
  reapSending(db, d)
  const rows = db.prepare('SELECT id, lead_id, to_email, subject, body, status, error, created_at, sent_at, test FROM outreach_messages WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200').all(tenantId) as { id: string; lead_id: string; to_email: string; subject: string; body: string; status: string; error: string | null; created_at: number; sent_at: number | null; test: number }[]
  // The draft list carries the evidence basis so the approval UI can label a human
  // confirmation (never presented as dazl's verification) or a withdrawn one.
  const sender = getSettings(db, tenantId)
  return rows.map(r => ({ ...r, send_footer: sendFooter(r.body, sender), evidence_state: leadEvidenceState(db, tenantId, r.lead_id), currentness_held: !testFixtureSend(db,tenantId,r) && currentnessHeld(db,tenantId,r.lead_id), provenance: messageProvenance(db,tenantId,r.lead_id,r.to_email) }))
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

// Every check approve makes before its write transaction, in the same order. Throws OutreachError on the first refusal.
function approveChecks(db: Database.Database, tenantId: string, id: string, sequenceSet: boolean, skipAccount = false) {
  if (!sequenceSet && tableExists(db, 'sequences') && db.prepare("SELECT 1 FROM sequences WHERE tenant_id = ? AND message_id = ? AND status NOT IN ('stopped','done')").get(tenantId, id)) throw new OutreachError('approve_sequence_set')
  const m = getMsg(db, tenantId, id)
  if (!m) throw new OutreachError('not_found')
  if (m.status !== 'draft') throw new OutreachError('not_a_draft')
  if (!skipAccount && !getSettings(db, tenantId)) throw new OutreachError('sender_identity_missing')
  if (!skipAccount && gmailStatus(db, tenantId)?.status !== 'active') throw new OutreachError('gmail_not_connected')
  if (isSuppressed(db, tenantId, m.to_email)) throw new OutreachError('suppressed')
  if (contactPurposeRestricted(db,tenantId,m.lead_id,m.to_email)) throw new OutreachError('not_sales_contact')
  if (!testFixtureSend(db,tenantId,m) && currentnessHeld(db,tenantId,m.lead_id)) throw new OutreachError('lead_currentness_unconfirmed')
  if (!testFixtureSend(db, tenantId, m) && !leadEvidenceEligible(db, tenantId, m.lead_id)) throw new OutreachError('lead_evidence_withdrawn')
  return m
}

// Read-only: why approve would refuse this message right now (its error code), or null. The same approveChecks plus the
// identity hold approve re-reads under its write lock. skipAccount leaves out only the account-wide checks (sender details,
// Gmail) so a view can tell "fix your setup" apart from a hold on the lead itself; approve never skips them.
export function approveBlockReason(db: Database.Database, tenantId: string, id: string, o: { skipAccount?: boolean } = {}): string | null {
  try {
    const m = approveChecks(db, tenantId, id, false, !!o.skipAccount)
    if (!testFixtureSend(db, tenantId, m) && domainReviewHeld(db, tenantId, m.lead_id, m.to_email)) return domainHoldCode(db, tenantId, m.lead_id, m.to_email)
    return null
  } catch (e) { if (e instanceof OutreachError) return e.code; throw e }
}

export function approve(db: Database.Database, tenantId: string, id: string, sequenceSet = false): void {
  const m = approveChecks(db, tenantId, id, sequenceSet)
  db.transaction(() => {
    // Read under the write lock, the same lock the identity review action takes, so a withdraw cannot slip in between this check and the update.
    if (!testFixtureSend(db, tenantId, m) && domainReviewHeld(db, tenantId, m.lead_id, m.to_email)) throw new OutreachError(domainHoldCode(db, tenantId, m.lead_id, m.to_email))
    snapshotSignalContext(db, tenantId, id)
    db.prepare("UPDATE outreach_messages SET status = 'approved', approved_hash = ? WHERE id = ? AND tenant_id = ? AND status = 'draft'").run(hash(m.to_email, m.subject, m.body), id, tenantId)
  }).immediate()
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

// What the send path appends after the saved words (same composeBody): name, mailing address, unsubscribe line.
// The per-message link is minted at send, so the preview names it instead of showing a fake URL.
export function sendFooter(body: string, s: Settings | undefined): string | null {
  if (!s) return null
  return composeBody(body, s, '[your unsubscribe link, added when sent]').slice(body.trim().length).trim()
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
  sendPreChecks(db, tenantId, pre)
  return sendClaimed(db, tenantId, id, pre, d)
}

type StoredMsg = NonNullable<ReturnType<typeof getMsg>>
// Every check sendMessage makes before it claims the message, in the same order. Throws OutreachError on the first refusal.
function sendPreChecks(db: Database.Database, tenantId: string, pre: StoredMsg): void {
  if (contactPurposeRestricted(db,tenantId,pre.lead_id,pre.to_email)) throw new OutreachError('not_sales_contact')
  if (!recipientAllowed(db,tenantId,pre.to_email)) throw new OutreachError('personal_email')
  if (leadHeld(db, tenantId, pre.lead_id)) throw new OutreachError('lead_ungraded')
  if (!testFixtureSend(db,tenantId,pre) && currentnessHeld(db,tenantId,pre.lead_id)) throw new OutreachError('lead_currentness_unconfirmed')
  if (!testFixtureSend(db, tenantId, pre) && !leadEvidenceEligible(db, tenantId, pre.lead_id)) throw new OutreachError('lead_evidence_withdrawn')
  if (!testFixtureSend(db, tenantId, pre) && domainReviewHeld(db, tenantId, pre.lead_id, pre.to_email)) throw new OutreachError(domainHoldCode(db, tenantId, pre.lead_id, pre.to_email))
  if (anyUncertainSend(db, tenantId)) throw new OutreachError('already_uncertain')
  if (tableExists(db, 'autopilot_settings') && (db.prepare('SELECT paused FROM autopilot_settings WHERE tenant_id = ?').get(tenantId) as { paused: number } | undefined)?.paused) throw new OutreachError('paused')
  // #413: never send on stale safety state - an opt-out that reply_sync has not ingested yet is invisible here.
  if (!testFixtureSend(db, tenantId, pre) && replySafetyStale(db, tenantId, pre.to_email)) throw new OutreachError('reply_sync_stale')
  if (pre.status !== 'approved') throw new OutreachError(pre.status === 'sending' || pre.status === 'uncertain' ? `already_${pre.status}` : 'not_approved')
}

// Read-only: why sendMessage would refuse this approved message right now (its error code), or null. The pre-claim checks
// above plus the account checks it makes after claiming (exact words still approved, sender identity, Gmail connected,
// the shared daily cap). Gmail itself can still fail at send time; this never claims or sends.
export function sendBlockReason(db: Database.Database, tenantId: string, id: string, o: { skipAccount?: boolean; now?: number } = {}): string | null {
  const now = o.now ?? Math.floor(Date.now() / 1000)
  const m = getMsg(db, tenantId, id)
  if (!m) return 'not_found'
  try { sendPreChecks(db, tenantId, m) } catch (e) { if (e instanceof OutreachError) return e.code; throw e }
  if (isSuppressed(db, tenantId, m.to_email)) return 'suppressed'
  if (m.approved_hash !== hash(m.to_email, m.subject, m.body)) return 'changed_since_approval'
  // skipAccount skips only the sender and Gmail checks; the shared daily cap is never skipped.
  if (!o.skipAccount && !getSettings(db, tenantId)) return 'sender_identity_missing'
  if (!o.skipAccount && !db.prepare('SELECT 1 FROM gmail_accounts WHERE tenant_id = ?').get(tenantId)) return 'gmail_not_connected'
  if (accountSendCount(db, tenantId, now) + 1 > DAILY_CAP) return 'daily_cap'
  return null
}

async function sendClaimed(db: Database.Database, tenantId: string, id: string, pre: StoredMsg, d: Deps): Promise<'sent' | 'uncertain'> {
  // The identity check and the claim are one write transaction (the same lock the review action takes), so a withdraw cannot land between them.
  const claim = db.transaction(() => {
    if (!testFixtureSend(db, tenantId, pre) && domainReviewHeld(db, tenantId, pre.lead_id, pre.to_email)) throw new OutreachError(domainHoldCode(db, tenantId, pre.lead_id, pre.to_email))
    // #417: a converted recipient fails closed AT THE CLAIM, atomically with it: an activated conversion, or a
    // pending one whose address is already verified (a lost activation drain must never allow a send).
    if (!testFixtureSend(db, tenantId, pre) && conversionBlockedNow(db, pre.to_email)) throw new OutreachError('converted')
    return db.prepare("UPDATE outreach_messages SET status = 'sending', attempts = attempts + 1, claimed_at = ?, error = NULL WHERE id = ? AND tenant_id = ? AND status = 'approved'").run(nowS(d), id, tenantId)
  }).immediate()
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
      // Production sets are always exactly 3 steps. A shorter set passes only for the
      // test-only fixture on the designated test tenant (exact inbox, allowlisted, test = 1);
      // every hash / changed-since-approval check still applies.
      const shortTestSet = testRecipientApproved(db, tenantId, m.to_email) && m.test === 1
      if ((steps.length !== 3 && !shortTestSet) || steps.length < 2 || steps.some(st => st.approved_hash !== hash(m.to_email,st.subject,st.body)) || !steps.some(st => st.step === 1 && st.subject === m.subject && st.body === m.body)) release('changed_since_approval')
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
  // A recheck that cannot run (a read fails) is a refusal, not an unknown outcome: nothing has left yet, the message goes
  // back to approved with that reason and the caller decides (fail closed).
  try {
  // The sending identity first: the account may have been disconnected or reconnected to another address meanwhile. The
  // message goes out only from the address read before the refresh (and, when given, the one the caller authorized).
  const sender = db.prepare('SELECT email FROM gmail_accounts WHERE tenant_id = ?').get(tenantId) as { email: string } | undefined
  if (!sender || sender.email.toLowerCase() !== acct!.email.toLowerCase() || (d.expectSender !== undefined && d.expectSender.toLowerCase() !== sender.email.toLowerCase())) release('sender_changed')
  // #413: safety ingest can also fall behind during the await - release and hold, never send.
  if (!testFixtureSend(db, tenantId, m) && replySafetyStale(db, tenantId, m.to_email, nowS(d), m.id)) release('reply_sync_stale')
  // #417: a conversion proven during the refresh stops the send terminally - never released back to approved,
  // where it could linger past an activation that skips only draft/approved rows.
  if (!testFixtureSend(db,tenantId,m) && conversionBlockedNow(db, m.to_email)) {
    db.prepare("UPDATE outreach_messages SET status = 'skipped', error = 'converted', claimed_at = NULL WHERE id = ? AND status = 'sending'").run(id)
    throw new OutreachError('converted')
  }
  if (contactPurposeRestricted(db,tenantId,m.lead_id,m.to_email)) release('not_sales_contact')
  if (!recipientAllowed(db,tenantId,m.to_email)) release('personal_email')
  if (leadHeld(db,tenantId,m.lead_id)) release('lead_ungraded')
  if (!testFixtureSend(db,tenantId,m) && currentnessHeld(db,tenantId,m.lead_id)) release('lead_currentness_unconfirmed')
  if (!testFixtureSend(db,tenantId,m) && !leadEvidenceEligible(db,tenantId,m.lead_id)) release('lead_evidence_withdrawn')
  if (!testFixtureSend(db,tenantId,m) && domainReviewHeld(db,tenantId,m.lead_id,m.to_email)) release(domainHoldCode(db,tenantId,m.lead_id,m.to_email))
  if (isSuppressed(db,tenantId,m.to_email)) release('suppressed')
  const final = getMsg(db,tenantId,id)!
  if (final.approved_hash !== hash(final.to_email,final.subject,final.body) || final.body !== m.body || final.subject !== m.subject || final.to_email !== m.to_email) release('changed_since_approval')
  if (tableExists(db,'sequences')) {
    const set = db.prepare('SELECT status FROM sequences WHERE tenant_id = ? AND message_id = ?').get(tenantId,id) as {status:string} | undefined
    if (set && set.status !== 'approved') release('approve_sequence_set')
  }
  if (tableExists(db,'autopilot_settings') && (db.prepare('SELECT paused FROM autopilot_settings WHERE tenant_id = ?').get(tenantId) as {paused:number}|undefined)?.paused) release('paused')
  if (d.authorize) { const why = d.authorize(); if (why) release(why) }
  } catch (e) {
    if (e instanceof OutreachError) throw e
    captureError(e, { source: 'worker', where: 'outreach:send:recheck', tenantId })
    release('authority_unreadable')
  }
  const master = d.master ?? getMasterKey()
  const unsubUrl = `${baseUrl(d)}/api/unsubscribe?t=${unsubToken(id, master)}`
  const raw = toBase64Url(buildMime({
    fromName: settings!.sender_name, fromEmail: acct!.email, to: m.to_email, subject: m.subject,
    body: composeBody(m.body, settings!, unsubUrl), messageId: `dazl.${id}@${acct!.email.split('@')[1]}`, unsubscribeUrl: unsubUrl, date: new Date(nowS(d) * 1000),
  }))
  try {
    const out = confirmedSendResult(await (d.sendFn ?? gmailSend)(token, raw, d.fetchImpl))
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
