// Delivery-status notices that arrive OUTSIDE the outreach thread (#415). A bounce can come back as a new thread from
// mailer-daemon / postmaster, which the per-thread reply sync never opens. This reads only those notices, under the read
// scope and read consent the tenant already granted (the consent text names bounces), with a Gmail search that returns
// nothing but delivery-notice senders - no other mailbox content is listed or opened.
//
// A notice acts only when it is tied to one exact message dazl sent and that message's recipient:
//  - its structured delivery-status part (RFC 3464) names a Final-Recipient and an Action / Status;
//  - the returned original headers carry the Message-ID dazl gave the send (dazl.<id>@..., dazl.f<n>.<id>@..., dazl.reopen.<id>@...);
//  - that message exists for this tenant, was sent, and was sent to exactly that Final-Recipient;
//  - the notice is not marked unauthenticated (an Authentication-Results header with dkim=fail or spf=fail).
// Only a permanent failure (Action: failed with a 5.x.x Status) suppresses, and only that recipient. A 4.x.x / delayed
// notice is recorded as soft. A notice that does not correlate (no structured part, an unknown or another tenant's
// message id, a different recipient, a code merely quoted in text) suppresses nobody: it is recorded and left.
// A notice that acted is recorded once (inbound_messages keys on the Gmail id), so the bounce count moves once.
import type Database from 'better-sqlite3'
import type { GPart } from './reply-text.ts'
import { recordBounce } from './autopilot.ts'

export const DSN_QUERY = 'from:(mailer-daemon OR postmaster) newer_than:30d'
const norm = (s: string) => s.trim().toLowerCase()

export interface DsnFields { recipients: { final: string; action: string | null; status: string | null }[]; messageIds: string[]; authFailed: boolean }

const text = (p: GPart) => { const d = p.body?.data; return d ? Buffer.from(d, 'base64url').toString('utf8') : '' }
// Parses the parts of a notice. `attachments` holds already-fetched attachment bodies by attachment id.
export function parseDsn(payload: GPart | undefined, topHeaders: { name: string; value: string }[] = [], attachments: Record<string, string> = {}): DsnFields {
  const out: DsnFields = { recipients: [], messageIds: [], authFailed: false }
  const auth = topHeaders.filter(h => h.name.toLowerCase() === 'authentication-results').map(h => h.value.toLowerCase())
  out.authFailed = auth.some(v => /\b(dkim|spf)=fail\b/.test(v))
  const walk = (p: GPart | undefined) => {
    if (!p) return
    const mt = (p.mimeType ?? '').toLowerCase()
    const body = p.body?.attachmentId ? attachments[p.body.attachmentId] ?? '' : text(p)
    if (mt === 'message/delivery-status') {
      // per-recipient groups are separated by blank lines; the first group is per-message
      for (const group of body.replace(/\r/g, '').split(/\n\s*\n/)) {
        const f = (n: string) => group.match(new RegExp(`^${n}:\\s*(.+)$`, 'im'))?.[1].trim() ?? null
        const final = f('Final-Recipient')
        if (!final) continue
        const addr = final.replace(/^rfc822\s*;\s*/i, '').replace(/^<|>$/g, '')
        out.recipients.push({ final: norm(addr), action: f('Action')?.toLowerCase() ?? null, status: f('Status') })
      }
    }
    if (mt === 'text/rfc822-headers' || mt === 'message/rfc822') {
      for (const m of body.matchAll(/^message-id:\s*<([^>]+)>/gim)) out.messageIds.push(m[1].trim())
      for (const h of p.headers ?? []) if (h.name.toLowerCase() === 'message-id') { const v = h.value.match(/<([^>]+)>/)?.[1]; if (v) out.messageIds.push(v.trim()) }
    }
    for (const c of p.parts ?? []) walk(c)
  }
  walk(payload)
  return out
}

// The outreach message a dazl Message-ID names: dazl.<id>@, dazl.f<n>.<id>@ (a follow-up), dazl.reopen.<id>@.
export const outreachIdOf = (messageId: string, domain: string): string | null => {
  const m = messageId.match(/^dazl\.(?:f\d+\.|reopen\.)?([0-9a-f]{8,64})@(.+)$/i)
  return m && norm(m[2]) === norm(domain) ? m[1] : null
}

export interface DsnResult { checked: boolean; notices: number; bounces: number; soft: number; unmatched: number }
type Get = (path: string) => Promise<unknown>
interface GMsg { id: string; threadId: string; internalDate?: string; payload?: GPart & { headers?: { name: string; value: string }[] } }

export async function ingestDeliveryNotices(db: Database.Database, tenantId: string, accountEmail: string, get: Get, now: number): Promise<DsnResult> {
  const r: DsnResult = { checked: false, notices: 0, bounces: 0, soft: 0, unmatched: 0 }
  let list: { messages?: { id: string; threadId: string }[] }
  try { list = (await get(`messages?q=${encodeURIComponent(DSN_QUERY)}&maxResults=50`)) as typeof list } catch { return r } // coverage unknown, not "no bounces"
  r.checked = true
  const domain = accountEmail.split('@')[1]
  for (const ref of list.messages ?? []) {
    if (db.prepare('SELECT 1 FROM inbound_messages WHERE tenant_id = ? AND gmail_id = ?').get(tenantId, ref.id)) continue // already seen (in-thread or earlier)
    let g: GMsg
    try { g = (await get(`messages/${ref.id}?format=full`)) as GMsg } catch { r.checked = false; continue }
    const headers = g.payload?.headers ?? []
    const from = norm((headers.find(h => h.name.toLowerCase() === 'from')?.value.match(/<([^>]+)>/)?.[1] ?? headers.find(h => h.name.toLowerCase() === 'from')?.value ?? ''))
    if (!/^(mailer-daemon|postmaster)@/.test(from)) continue // the search is a hint; the sender is checked again here
    r.notices++
    const attachments: Record<string, string> = {}
    const needs: string[] = []
    const scan = (p?: GPart) => { if (!p) return; if (p.body?.attachmentId && /^(message\/delivery-status|text\/rfc822-headers|message\/rfc822)$/i.test(p.mimeType ?? '')) needs.push(p.body.attachmentId); for (const c of p.parts ?? []) scan(c) }
    scan(g.payload)
    for (const a of needs) { try { const d = (await get(`messages/${ref.id}/attachments/${a}`)) as { data?: string }; if (d.data) attachments[a] = Buffer.from(d.data, 'base64url').toString('utf8') } catch { /* stays unreadable: no correlation */ } }
    const dsn = parseDsn(g.payload, headers, attachments)
    const at = Math.floor(Number(g.internalDate ?? 0) / 1000) || now
    // A notice tied to a dazl send is recorded in THAT send's conversation (as an in-thread bounce is), with its recipient
    // and status. One that is not (it may be about the user's own mail) is not stored at all: it is looked at again on a
    // later sync, never acted on.
    const log = (cls: string, m: { id: string; lead_id: string; thread_id: string | null }) => db.prepare('INSERT OR IGNORE INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at, outreach_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(g.id, tenantId, m.thread_id ?? g.threadId, m.lead_id, from, `delivery notice: ${dsn.recipients.map(x => `${x.final} ${x.action ?? '?'} ${x.status ?? '?'}`).join(', ')}`.slice(0, 200), cls, at, m.id)
    // the exact sent message this notice is about
    const sent = [...new Set(dsn.messageIds.map(id => outreachIdOf(id, domain)).filter((x): x is string => !!x))]
      .map(id => db.prepare("SELECT id, lead_id, to_email, thread_id, sent_at FROM outreach_messages WHERE id = ? AND tenant_id = ? AND status = 'sent'").get(id, tenantId) as { id: string; lead_id: string; to_email: string; thread_id: string | null; sent_at: number | null } | undefined)
      .filter((x): x is NonNullable<typeof x> => !!x)
    const match = sent.length === 1 ? sent[0] : null
    const rcpt = match ? dsn.recipients.find(x => x.final === norm(match.to_email)) : undefined
    if (!match || !rcpt || dsn.authFailed || (match.sent_at !== null && at < match.sent_at)) { r.unmatched++; continue }
    const permanent = rcpt.action === 'failed' && /^5\.\d{1,3}\.\d{1,3}$/.test(rcpt.status ?? '')
    if (!permanent) { log('soft_bounce', match); r.soft++; continue }
    recordBounce(db, tenantId, match.to_email, now)
    if (match.thread_id) db.prepare("UPDATE followup_threads SET stopped = 'bounce' WHERE tenant_id = ? AND thread_id = ?").run(tenantId, match.thread_id)
    // suppressing the address (recordBounce) already stops its sequences ('suppressed')
    log('bounce', match); r.bounces++
  }
  return r
}
