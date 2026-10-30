import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { gmailStatus } from '../gmail/oauth.ts'
import { auditAt } from './autopilot.ts'
import { grantConsent } from './ledger.ts'
import { hasReadConsent } from './replies.ts'
import { getSettings, isSuppressed, leadHeld } from './service.ts'
import { MAX_STEPS, sequenceStepText, stepHash } from './sequences.ts'

// #414: automatic cold follow-ups for autopilot's first touches. Three kinds of follow-up stay distinct:
//   - cold no-reply follow-ups (this file and lib/outreach/sequences.ts): steps 2 and 3 at +3 and +7 days after a first
//     email nobody answered; any reply, opt-out or bounce stops them;
//   - warm follow-ups (lib/outreach/followups.ts): only to people who replied with interest;
//   - reopens (lib/outreach/reopen.ts): a fresh, separately approved message 30-90 days later.
// Without this policy a cold sequence exists only when the user creates and approves one per lead. With it, the account
// approves once, under its own versioned policy (separate from autopilot's consent), that each first touch autopilot
// sends is followed by the two fixed template steps below, worded from the lead's own evidence. The exact words are
// snapshotted and hash-approved at enrollment; a step sends only while the policy is still on at the version it was
// enrolled under and from the same Gmail address the first touch went from. Steps still go through runSequences and
// every check it makes at send time (SEQUENCES_ENABLED, reply sync first, suppression, consent, caps, evidence).
// The policy's on/off history is the audit log (append-only), so it needs no new table.
export const AUTO_SEQUENCE_VERSION = '2026-10-30'
export const AUTO_SEQUENCE_TEXT = [
  'After autopilot sends a first email, dazl follows up at most twice in the same thread if nobody replies: 3 days and 7 days after the first email.',
  'The follow-ups are short fixed templates that mention only the lead\'s own public signal and your business name. They are not rewritten later.',
  'Any reply, opt-out or bounce stops the follow-ups for that person. Replies are read before every follow-up; if they cannot be read, nothing is sent.',
  'Follow-ups count toward your daily limit. Turning this off, changing your Gmail account, or pausing autopilot stops every follow-up that has not gone out.',
]

type Policy = { on: boolean; version: string | null; since: number | null }
// The latest switch wins; on and off in the same second count as off.
export function autoSequencePolicy(db: Database.Database, tenantId: string): Policy {
  const r = db.prepare("SELECT action, detail, created_at FROM autopilot_audit WHERE tenant_id = ? AND action IN ('auto_sequence_on','auto_sequence_off') ORDER BY created_at DESC, CASE WHEN action = 'auto_sequence_off' THEN 0 ELSE 1 END LIMIT 1").get(tenantId) as { action: string; detail: string | null; created_at: number } | undefined
  if (!r || r.action !== 'auto_sequence_on') return { on: false, version: null, since: null }
  return { on: r.detail === AUTO_SEQUENCE_VERSION, version: r.detail, since: r.created_at }
}

export class AutoSequenceError extends Error { code: string; constructor(code: string) { super(code); this.code = code } }

// Turning it on needs the current policy version and reply reading (follow-ups must stop on replies). Off always works.
export function setAutoSequence(db: Database.Database, tenantId: string, on: boolean, version?: string, now = Math.floor(Date.now() / 1000)): void {
  if (!on) { if (autoSequencePolicy(db, tenantId).version !== null) auditAt(db, tenantId, 'auto_sequence_off', undefined, undefined, undefined, now); return }
  if (version !== AUTO_SEQUENCE_VERSION) throw new AutoSequenceError('policy_version')
  if (!hasReadConsent(db, tenantId) || !gmailStatus(db, tenantId)?.read_granted) throw new AutoSequenceError('reading_not_enabled')
  auditAt(db, tenantId, 'auto_sequence_on', AUTO_SEQUENCE_VERSION, undefined, undefined, now)
}

// After autopilot's first touch went out: enroll the lead once. Returns the sequence id, or null when it is not
// enrolled (policy off or old, reading off, not a sent first touch with a thread, suppressed, held, or a sequence for
// this lead already exists: the UNIQUE (tenant, lead) row makes enrollment atomic, so a retry or a second pass never
// duplicates it). Never sends anything itself.
export function enrollAutoSequence(db: Database.Database, tenantId: string, messageId: string, sender: string, businessName: string, now = Math.floor(Date.now() / 1000)): string | null {
  const p = autoSequencePolicy(db, tenantId)
  if (!p.on || !sender || !hasReadConsent(db, tenantId) || !gmailStatus(db, tenantId)?.read_granted) return null
  const m = db.prepare("SELECT id, lead_id, to_email, subject, body, status, gmail_id, thread_id, test FROM outreach_messages WHERE id = ? AND tenant_id = ?").get(messageId, tenantId) as { id: string; lead_id: string; to_email: string; subject: string; body: string; status: string; gmail_id: string | null; thread_id: string | null; test: number } | undefined
  if (!m || m.status !== 'sent' || !m.gmail_id || !m.thread_id || m.test === 1) return null
  if (isSuppressed(db, tenantId, m.to_email) || leadHeld(db, tenantId, m.lead_id)) return null
  const lead = db.prepare('SELECT l.company, l.name, l.signal, l.source_url FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?').get(m.lead_id, tenantId) as { company: string; name: string; signal: string; source_url: string } | undefined
  if (!lead) return null
  const booking = getSettings(db, tenantId)?.booking_url
  const re = m.subject.startsWith('Re:') ? m.subject : `Re: ${m.subject}`
  const steps = [{ step: 1, subject: m.subject, body: m.body }, ...([2, 3] as const).map(step => ({ step, subject: re, body: sequenceStepText(step, lead, businessName, booking) }))]
  if (steps.length !== MAX_STEPS) return null
  const id = randomBytes(12).toString('hex')
  return db.transaction(() => {
    if (db.prepare("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status) VALUES (?, ?, ?, ?, ?, 'approved') ON CONFLICT (tenant_id, lead_id) DO NOTHING").run(id, tenantId, m.lead_id, m.id, m.to_email).changes !== 1) return null
    const ins = db.prepare("INSERT INTO sequence_steps (tenant_id, sequence_id, step, subject, body, approved_hash, status) VALUES (?, ?, ?, ?, ?, ?, 'approved')")
    for (const st of steps) ins.run(tenantId, id, st.step, st.subject, st.body, stepHash(m.to_email, st.subject, st.body))
    grantConsent(db, tenantId, m.to_email, { channel: 'email', scope: 'sequence', basis: 'auto_sequence_policy', evidenceRef: `sequence:${id}`, now })
    auditAt(db, tenantId, 'sequence_enrolled', JSON.stringify({ v: p.version, from: sender.toLowerCase() }), m.lead_id, m.id, now)
    return id
  })()
}

// For runSequences, before claiming and again right before sending a step: an auto-enrolled sequence sends only under
// the policy version it was enrolled with and from the address its first touch used. Returns why it must stop, or null
// (also null for a sequence the user approved by hand, which this policy never governs).
export function autoSequenceStop(db: Database.Database, tenantId: string, messageId: string, sender: string | null | undefined): string | null {
  const r = db.prepare("SELECT detail FROM autopilot_audit WHERE tenant_id = ? AND message_id = ? AND action = 'sequence_enrolled' LIMIT 1").get(tenantId, messageId) as { detail: string | null } | undefined
  if (!r) return null
  let e: { v?: string; from?: string } = {}
  try { e = JSON.parse(r.detail ?? '{}') } catch { return 'policy_changed' }
  const p = autoSequencePolicy(db, tenantId)
  if (!p.on || p.version !== e.v) return 'policy_changed'
  if (!sender || sender.toLowerCase() !== e.from) return 'sender_changed'
  return null
}
