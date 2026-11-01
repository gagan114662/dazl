// Delivery-status notification (DSN, RFC 3464) parsing and verdicts (#415). Pure: no network, no model, nothing
// stored. Bounce notices often arrive OUTSIDE the thread dazl started, so the thread sync never sees them; this
// module decides what a candidate notice may prove about a recorded send.
//
// Provenance bar (a mailer-daemon From name and quoted identifiers are NOT proof - any received message can carry
// them): a permanent suppression needs ALL of
//   1. the first Authentication-Results header (prepended by the receiving MX, i.e. Gmail itself) showing spf=pass
//      or dkim=pass - an unauthenticated notice that otherwise correlates is HELD, never acted on;
//   2. the returned original Message-ID matching a recorded outreach send (a random per-send id the sender of a
//      forged notice cannot know for anyone but themselves);
//   3. the DSN's Final-Recipient block matching exactly the recorded send's to_email - an unrelated recipient in
//      the same notice is never suppressed.
// A 4.x status or a non-failed action is soft forever, authenticated or not. Residual risk, documented: the
// recipient of a send could forge their own authenticated-looking bounce; the effect approximates a self-opt-out,
// and bounce accounting (recordBounce pause thresholds) is the monitor for abuse at volume.
import type { GPart } from './reply-text.ts'

export interface DsnRecipient { finalRecipient: string | null; action: string | null; status: string | null }
export interface DsnParse { recipients: DsnRecipient[]; originalMessageId: string | null }
export type DsnVerdict =
  | { kind: 'permanent'; recipient: string; originalMessageId: string }
  | { kind: 'soft'; recipient: string; status: string }
  | { kind: 'hold'; reason: string }
  | { kind: 'ignore'; reason: string }

const hdr = (p: GPart | undefined, n: string): string => p?.headers?.find(h => h.name.toLowerCase() === n)?.value ?? ''
const b64 = (p: GPart | undefined): string => { try { return p?.body?.data ? Buffer.from(p.body.data, 'base64url').toString('utf8') : '' } catch { return '' } }

function findPart(p: GPart | undefined, mime: string, depth = 0): GPart | undefined {
  if (!p || depth > 12) return undefined
  if ((p.mimeType ?? '').toLowerCase() === mime) return p
  for (const c of p.parts ?? []) { const r = findPart(c, mime, depth + 1); if (r) return r }
  return undefined
}

// field blocks of a message/delivery-status body: blank-line separated; block 0 is per-message, the rest per-recipient.
function blocks(text: string): Record<string, string>[] {
  return text.split(/\r?\n\r?\n/).map(b => {
    const o: Record<string, string> = {}
    for (const line of b.split(/\r?\n/)) { const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line); if (m) o[m[1].toLowerCase()] = m[2].trim() }
    return o
  }).filter(o => Object.keys(o).length > 0)
}

export function parseDsn(root: GPart | undefined): DsnParse | null {
  if (!root) return null
  const isReport = (root.mimeType ?? '').toLowerCase() === 'multipart/report' && /report-type\s*=\s*delivery-status/i.test(hdr(root, 'content-type'))
  if (!isReport) return null
  const status = findPart(root, 'message/delivery-status')
  if (!status) return null
  const recs = blocks(b64(status)).slice(1).map(b => ({
    finalRecipient: b['final-recipient']?.replace(/^rfc822\s*;\s*/i, '') ?? null,
    action: b['action']?.toLowerCase() ?? null,
    status: b['status'] ?? null,
  }))
  if (!recs.length) return null
  // the original Message-ID: from the returned headers (message/rfc822 or text/rfc822-headers part), never from
  // the human-readable first part, which is MTA free text.
  let originalMessageId: string | null = null
  const returned = findPart(root, 'message/rfc822') ?? findPart(root, 'text/rfc822-headers')
  if (returned) {
    originalMessageId = /<([^>]+)>/.exec(hdr(returned, 'message-id'))?.[1]
      ?? /<([^>]+)>/i.exec(/^Message-ID:\s*(.+)$/im.exec(b64(returned))?.[1] ?? '')?.[1]
      ?? null
  }
  return { recipients: recs, originalMessageId }
}

// The FIRST Authentication-Results header is the one the receiving MX prepended; deeper ones travel with the message.
export function dsnSourceAuthenticated(root: GPart | undefined): boolean {
  const first = root?.headers?.find(h => h.name.toLowerCase() === 'authentication-results')?.value ?? ''
  return /\b(spf|dkim|dmarc)=pass\b/i.test(first)
}

export const isDsnSender = (from: string): boolean => /^(mailer-daemon|postmaster)@/i.test(from.trim())

// lookup: recorded send by exact Message-ID token (dazl.<id>@<domain>), undefined when nothing was sent with it.
export function decideDsn(root: GPart | undefined, from: string, lookup: (originalMessageId: string) => { id: string; to_email: string } | undefined): DsnVerdict {
  if (!isDsnSender(from)) return { kind: 'ignore', reason: 'not_a_dsn_sender' }
  const dsn = parseDsn(root)
  if (!dsn) return { kind: 'ignore', reason: 'not_a_dsn' }
  if (!dsn.originalMessageId) return { kind: 'ignore', reason: 'no_original_message_id' }
  const send = lookup(dsn.originalMessageId)
  if (!send) return { kind: 'ignore', reason: 'unknown_original' }
  const rec = dsn.recipients.find(r => (r.finalRecipient ?? '').toLowerCase() === send.to_email.toLowerCase())
  if (!rec) return { kind: 'ignore', reason: 'recipient_mismatch' } // never suppress an unrelated recipient
  const recipient = send.to_email
  const permanent = rec.action === 'failed' && !!rec.status && /^5\.\d{1,3}\.\d{1,3}$/.test(rec.status)
  if (!permanent) return { kind: 'soft', recipient, status: rec.status ?? 'unknown' } // 4.x / delayed / expanded: never permanent
  if (!dsnSourceAuthenticated(root)) return { kind: 'hold', reason: 'unauthenticated_source' }
  return { kind: 'permanent', recipient, originalMessageId: dsn.originalMessageId }
}
