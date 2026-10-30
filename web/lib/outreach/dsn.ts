import type { GPart } from './reply-text.ts'

// #415: the structured fields of a delivery-status notice (RFC 3464), from a Gmail message payload. Only what the
// notice states in its machine-readable parts counts: per-recipient Final-Recipient / Action / Status from the
// message/delivery-status part, and the Message-ID of the returned original from its message/rfc822 or
// text/rfc822-headers part. A status code quoted anywhere else (the human-readable text, a forwarded message) is never
// read, so an arbitrary "5.1.1" in some email cannot suppress anyone. Pure; no I/O.

export interface DsnRecipient { recipient: string; action: string; status: string }
export interface DsnFacts { recipients: DsnRecipient[]; originalIds: string[] }

const MAX_DEPTH = 12
const B64URL = /^[A-Za-z0-9_-]*={0,2}$/
const decode = (p: GPart): string => {
  const d = p.body?.data
  return d && B64URL.test(d) ? Buffer.from(d, 'base64url').toString('utf8').replace(/\0/g, '') : ''
}
function walk(p: GPart | undefined, f: (p: GPart) => void, depth = 0): void {
  if (!p || depth > MAX_DEPTH) return
  f(p)
  for (const c of p.parts ?? []) walk(c, f, depth + 1)
}
// Unfolded header fields of a block of "Name: value" lines.
function fields(block: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of block.replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ').split('\n')) {
    const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line)
    if (m && !out.has(m[1].toLowerCase())) out.set(m[1].toLowerCase(), m[2].trim())
  }
  return out
}
const addrOf = (v: string) => (v.replace(/^rfc822;\s*/i, '').match(/<([^>]+)>/)?.[1] ?? v.replace(/^rfc822;\s*/i, '')).trim().toLowerCase()

export function parseDsn(payload: GPart | undefined): DsnFacts | null {
  if (!payload || !/^multipart\/report\b/i.test(payload.mimeType ?? '') ) return null
  const recipients: DsnRecipient[] = []
  const originalIds = new Set<string>()
  walk(payload, p => {
    const mt = (p.mimeType ?? '').toLowerCase()
    if (mt === 'message/delivery-status') {
      // First block: per-message fields; each later block: one recipient.
      const blocks = decode(p).replace(/\r\n/g, '\n').split(/\n\s*\n/).map(fields)
      for (const b of blocks) {
        const r = b.get('final-recipient'), action = b.get('action'), status = b.get('status')
        if (r && action && status && /^[245]\.\d{1,3}\.\d{1,3}$/.test(status.split(/\s/)[0])) recipients.push({ recipient: addrOf(r), action: action.toLowerCase(), status: status.split(/\s/)[0] })
      }
    } else if (mt === 'message/rfc822' || mt === 'text/rfc822-headers') {
      // The returned original: its own Message-ID only (never In-Reply-To or References, which name other messages).
      const id = p.headers?.find(h => h.name.toLowerCase() === 'message-id')?.value ?? p.parts?.[0]?.headers?.find(h => h.name.toLowerCase() === 'message-id')?.value ?? fields(decode(p).split(/\r?\n\r?\n/)[0]).get('message-id')
      if (id) originalIds.add(id.trim())
    }
  })
  return recipients.length ? { recipients, originalIds: [...originalIds] } : null
}

// The outreach message a dazl Message-ID names (first touch, sequence step, follow-up or reopen), with the domain it
// was sent from: dazl.<id>@, dazl.s2.<id>@, dazl.f0.<id>@, dazl.reopen.<id>@.
export function dazlMessageRef(messageId: string): { id: string; domain: string } | null {
  const m = /^<?dazl\.(?:s\d\.|f\d{1,2}\.|reopen\.)?([0-9a-f]{24})@([^>\s]+)>?$/i.exec(messageId.trim())
  return m ? { id: m[1].toLowerCase(), domain: m[2].toLowerCase() } : null
}

// A permanent failure for that recipient: Action failed with a 5.x.x status. Delayed, relayed or 4.x.x is not.
export const permanentFailure = (r: DsnRecipient) => r.action === 'failed' && r.status.startsWith('5.')
