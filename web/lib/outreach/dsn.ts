// Delivery-status notification (DSN, RFC 3464) parsing and verdicts (#415). Pure: no network, no model, nothing
// stored. Bounce notices often arrive OUTSIDE the thread dazl started, so the thread sync never sees them; this
// module decides what a candidate notice may prove about a recorded send.
//
// Provenance bar - every one of these identifiers appears in FORGED received mail, so none is proof alone:
//   - a mailer-daemon/postmaster From name: a pre-filter only;
//   - the original Message-ID: correlates, but the recipient of a send knows it, so it is not authentication;
//   - an Authentication-Results 'pass': authenticates only the domain it names - an attacker's OWN domain passes
//     on the attacker's own notice. It counts only when BOTH:
//       a. it sits on the FIRST Authentication-Results header AND that header's authserv-id is a receiving MX we
//          trust (the tenant's mailbox provider; any deeper header travelled with the message and is injectable),
//       b. the authenticated domain ALIGNS with a domain expected to issue bounces for the recipient (the
//          recipient domain's MX hosts, supplied by the caller as expectedBounceDomains - provider/DNS-derived,
//          never taken from the notice itself). Without caller-supplied alignment there is no trustworthy origin
//          evidence offline and the notice is HELD as unverified, however perfect it looks.
// A 4.x status or a non-failed action is soft forever, authenticated or not. Residual risk, documented: the
// recipient's own MX can issue a forged-but-fully-aligned notice; the effect approximates a self-opt-out, and
// bounce accounting (recordBounce pause thresholds) is the volume monitor. A 'permanent' verdict here is a
// CANDIDATE: suppression wiring is a separate, later decision and this module performs none.
import type { GPart } from './reply-text.ts'

export interface DsnRecipient { finalRecipient: string | null; action: string | null; status: string | null }
export interface DsnParse { recipients: DsnRecipient[]; originalMessageId: string | null }
export type DsnVerdict =
  | { kind: 'permanent'; recipient: string; originalMessageId: string; outreachMessageId: string }
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

export interface DsnAuth { authservId: string; passDomains: string[] }

// Only the FIRST Authentication-Results header can be the one the receiving MX prepended at receipt; every deeper
// header travelled with the message and is injectable. Even then, a bare 'pass' is not trusted origin evidence:
// it authenticates whatever domain it names, which may be the attacker's own. The caller decides trust via
// trustedAuthservIds (the tenant mailbox provider's authserv-ids) and alignment via expectedBounceDomains.
export function firstAuthenticationResults(root: GPart | undefined): DsnAuth | null {
  const first = root?.headers?.find(h => h.name.toLowerCase() === 'authentication-results')?.value ?? ''
  if (!first.trim()) return null
  const authservId = first.split(';', 1)[0].trim().toLowerCase()
  const passDomains: string[] = []
  for (const m of first.matchAll(/\bspf=pass\b[^;]*?\bsmtp\.mailfrom=([^\s;]+)/gi)) passDomains.push(m[1].toLowerCase().replace(/^[.@]+/, ''))
  for (const m of first.matchAll(/\bdkim=pass\b[^;]*?\bheader\.d=([^\s;]+)/gi)) passDomains.push(m[1].toLowerCase().replace(/^[.@]+/, ''))
  for (const m of first.matchAll(/\bdmarc=pass\b[^;]*?\bheader\.from=([^\s;]+)/gi)) passDomains.push(m[1].toLowerCase().replace(/^[.@]+/, ''))
  return { authservId, passDomains }
}

const domainMatches = (candidate: string, expected: string[]): boolean =>
  expected.some(e => { const x = e.toLowerCase(); return candidate === x || candidate.endsWith('.' + x) })

// Trusted origin evidence: trusted receiving-MX authserv-id AND an authenticated domain aligned with the
// caller-supplied expected bounce origins. Anything less is not provenance.
export function dsnProvenance(root: GPart | undefined, trust: { trustedAuthservIds: string[]; expectedBounceDomains: string[] }): { ok: boolean; reason?: string } {
  const ar = firstAuthenticationResults(root)
  if (!ar) return { ok: false, reason: 'no_authentication_results' }
  if (!trust.trustedAuthservIds.map(x => x.toLowerCase()).includes(ar.authservId)) return { ok: false, reason: 'untrusted_authserv' }
  if (!trust.expectedBounceDomains.length) return { ok: false, reason: 'no_expected_origins' }
  if (!ar.passDomains.some(d => domainMatches(d, trust.expectedBounceDomains))) return { ok: false, reason: 'domain_not_aligned' }
  return { ok: true }
}

export const isDsnSender = (from: string): boolean => /^(mailer-daemon|postmaster)@/i.test(from.trim())

// lookup: recorded send by exact Message-ID token (dazl.<id>@<domain>), undefined when nothing was sent with it.
export function decideDsn(root: GPart | undefined, from: string, lookup: (originalMessageId: string) => { id: string; to_email: string } | undefined, trust: { trustedAuthservIds: string[]; expectedBounceDomains: string[] } = { trustedAuthservIds: [], expectedBounceDomains: [] }): DsnVerdict {
  if (!isDsnSender(from)) return { kind: 'ignore', reason: 'not_a_dsn_sender' }
  const dsn = parseDsn(root)
  if (!dsn) return { kind: 'ignore', reason: 'not_a_dsn' }
  if (!dsn.originalMessageId) return { kind: 'ignore', reason: 'no_original_message_id' }
  const send = lookup(dsn.originalMessageId)
  if (!send) return { kind: 'ignore', reason: 'unknown_original' }
  const rec = dsn.recipients.find(r => (r.finalRecipient ?? '').toLowerCase() === send.to_email.toLowerCase())
  if (!rec) return { kind: 'ignore', reason: 'recipient_mismatch' } // never suppress an unrelated recipient
  const recipient = send.to_email
  const failed5xx = rec.action === 'failed' && !!rec.status && /^5\.\d{1,3}\.\d{1,3}$/.test(rec.status)
  if (!failed5xx) return { kind: 'soft', recipient, status: rec.status ?? 'unknown' } // 4.x / delayed / expanded: never permanent
  const prov = dsnProvenance(root, trust)
  // Without established provenance a correlated notice is HELD as unverified - it is evidence for a person,
  // never for a suppression. When provenance cannot be established at all (no expected origins supplied), that
  // is the standing posture, not an error.
  if (!prov.ok) return { kind: 'hold', reason: prov.reason ?? 'unverified' }
  return { kind: 'permanent', recipient, originalMessageId: dsn.originalMessageId, outreachMessageId: send.id }
}
