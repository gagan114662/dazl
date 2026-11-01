// Delivery-failure scanning (#415) is its OWN consent, separate from reply reading: accepting reply reading
// (2026-10-21) does not authorize this scan, and this scan never widens what reply reading opens. There is no
// backfill and no auto-acceptance - the tenant accepts this exact version in settings.
//
// Method-honest scope (the consent text below says exactly this):
//   - the scan is a bounded candidate LIST (bounce-sender/subject query) plus a fetch of those candidates,
//     which can include notices about email dazl did not send - no other mail is listed or opened;
//   - a candidate is correlated only against sends recorded in outreach_messages (the Message-ID dazl wrote);
//   - a candidate that does not match a recorded send is DISCARDED: nothing from it is stored;
//   - provenance follows decideDsn: the receiving MX's first Authentication-Results, aligned with the
//     recipient domain's MX hosts resolved by DNS at scan time, never taken from the notice itself;
//   - what cannot be verified is HELD as unknown and never acted on.
//
// Suppression wiring is NOT cleared: syncBounceNotices applies verdicts only when the caller passes
// { apply: true }. Nothing calls it yet - that and live reads await clearance.
import type Database from 'better-sqlite3'
import { resolveMx } from 'node:dns/promises'
import { getAccessToken, type OAuthDeps } from '../gmail/oauth.ts'
import { decideDsn, parseDsn } from './dsn.ts'
import { applyBounceVerdict } from './bounce-ledger.ts'
import type { GPart } from './reply-text.ts'

export const BOUNCE_SCAN_CONSENT_VERSION = '2026-11-01-bounce-scan-1'
export const BOUNCE_SCAN_CONSENT_TEXT = [
  'dazl will scan your inbox for delivery-failure notices (bounce messages). This includes notices about email dazl did not send, because they arrive the same way. dazl will not read any other email.',
  'dazl opens only messages that look like delivery failures and checks each against the emails it actually sent for you. A verified match stops further email to an address that cannot receive mail.',
  'A notice that does not match an email dazl sent is discarded right away; nothing from it is kept. For a verified match dazl keeps the bounce record: the recipient address, the reason, which email it was, and the date.',
  'Some notices cannot be verified - for example when the notice does not identify the original email or its source cannot be authenticated. dazl treats those as unknown and does not act on them.',
  'You can turn this off any time. Turning it off stops the scan. Bounces already recorded stay in place.',
]

export function migrateBounceScan(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS mail_bounce_scan_consent (tenant_id TEXT PRIMARY KEY, version TEXT NOT NULL, accepted_at INTEGER NOT NULL DEFAULT (CAST(strftime(\'%s\',\'now\') AS INTEGER)))')
}

export const acceptBounceScanConsent = (db: Database.Database, tenantId: string) =>
  db.prepare('INSERT INTO mail_bounce_scan_consent (tenant_id, version) VALUES (?, ?) ON CONFLICT(tenant_id) DO UPDATE SET version = excluded.version, accepted_at = CAST(strftime(\'%s\',\'now\') AS INTEGER)').run(tenantId, BOUNCE_SCAN_CONSENT_VERSION)
export const revokeBounceScanConsent = (db: Database.Database, tenantId: string) =>
  db.prepare('DELETE FROM mail_bounce_scan_consent WHERE tenant_id = ?').run(tenantId)
export const hasBounceScanConsent = (db: Database.Database, tenantId: string) =>
  (db.prepare('SELECT version FROM mail_bounce_scan_consent WHERE tenant_id = ?').get(tenantId) as { version: string } | undefined)?.version === BOUNCE_SCAN_CONSENT_VERSION

// The tenant's mailbox is read through the Gmail API, so the receiving MX whose first Authentication-Results
// can be trusted is Google's. Expected bounce origins are the recipient domain's MX hosts, resolved by DNS at
// scan time (cached per run). Evidence never comes from the notice itself: the recipient domain is taken from the recorded send; when DNS cannot answer, evidence narrows to that domain alone.
const TRUSTED_AUTHSERV_IDS = ['mx.google.com', 'google.com']
const DSN_LIST_QUERY = 'from:(mailer-daemon OR postmaster) OR subject:("delivery status notification" OR "undelivered" OR "failure notice" OR "returned mail")'
const MAX_CANDIDATES = 25

const defaultResolveMx = async (domain: string): Promise<string[]> => (await resolveMx(domain)).map(r => r.exchange.toLowerCase())

export interface BounceScanDeps extends OAuthDeps { resolveMxFor?: (domain: string) => Promise<string[]> }
export interface BounceScanResult { listed: number; fetched: number; matched: number; recorded: number; duplicate: number; held: number; discarded: number; applied: boolean; error?: string }

export async function syncBounceNotices(db: Database.Database, tenantId: string, d: BounceScanDeps = {}, opts: { apply?: boolean } = {}): Promise<BounceScanResult> {
  const out: BounceScanResult = { listed: 0, fetched: 0, matched: 0, recorded: 0, duplicate: 0, held: 0, discarded: 0, applied: opts.apply === true }
  // The consent check precedes ANY mailbox call: without the exact-version acceptance there is no list, no fetch.
  if (!hasBounceScanConsent(db, tenantId)) return { ...out, error: 'bounce_scan_not_enabled' }
  const acct = db.prepare('SELECT email, read_granted, status FROM gmail_accounts WHERE tenant_id = ?').get(tenantId) as { email: string; read_granted: number; status: string } | undefined
  if (!acct || acct.read_granted !== 1 || acct.status !== 'active') return { ...out, error: 'reading_not_enabled' }
  const token = await getAccessToken(db, tenantId, d)
  const f = d.fetchImpl ?? fetch
  const get = async (path: string) => {
    const r = await f(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) })
    if (!r.ok) throw new Error(`gmail_${r.status}`)
    return r.json()
  }
  const list = (await get(`messages?q=${encodeURIComponent(DSN_LIST_QUERY)}&maxResults=${MAX_CANDIDATES}`)) as { messages?: { id: string }[] }
  const ids = (list.messages ?? []).map(m => m.id)
  out.listed = ids.length
  const lookup = (originalMessageId: string) => {
    const m = /^dazl\.(?:s\d+\.)?([a-f0-9]{24})@/i.exec(originalMessageId)
    if (!m) return undefined
    return db.prepare('SELECT id, to_email FROM outreach_messages WHERE tenant_id = ? AND id = ?').get(tenantId, m[1].toLowerCase()) as { id: string; to_email: string } | undefined
  }
  const mxCache = new Map<string, Promise<string[]>>()
  const mxOf = (domain: string) => {
    let p = mxCache.get(domain)
    if (!p) { p = (d.resolveMxFor ?? defaultResolveMx)(domain).catch(() => []); mxCache.set(domain, p) }
    return p
  }
  for (const id of ids) {
    const msg = (await get(`messages/${id}?format=full`)) as { payload?: GPart }
    out.fetched++
    const payload = msg.payload
    const fromHeader = payload?.headers?.find(h => h.name.toLowerCase() === 'from')?.value ?? ''
    const from = (/<([^>]+)>/.exec(fromHeader)?.[1] ?? fromHeader).trim() // the pre-filter wants the bare address
    // Origin evidence is per-recipient: correlate first (recorded sends only), then resolve that recipient
    // domain's MX hosts. A candidate that never correlates is discarded without any DNS work.
    let expected: string[] = []
    const parsed = parseDsn(payload)
    if (parsed?.originalMessageId) {
      const send = lookup(parsed.originalMessageId)
      if (send) {
        const domain = send.to_email.split('@')[1]
        expected = [domain, ...(await mxOf(domain))]
      }
    }
    const verdict = decideDsn(payload, from, lookup, { trustedAuthservIds: TRUSTED_AUTHSERV_IDS, expectedBounceDomains: expected })
    if (verdict.kind === 'hold') { out.held++; continue } // unverified: evidence for a person, never written
    if (verdict.kind !== 'permanent') { out.discarded++; continue } // not a bounce, not ours, or not verifiable as ours
    out.matched++
    if (!out.applied) continue // suppression wiring not cleared: count the match, write nothing
    const r = applyBounceVerdict(db, tenantId, verdict, 'dsn', id)
    if (r === 'recorded') out.recorded++; else if (r === 'duplicate') out.duplicate++
  }
  return out
}
