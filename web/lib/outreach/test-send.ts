// #1709: "Send test to me". Before a user emails a prospect, they can send the exact final email — the saved
// words, the real footer (sender name, postal address, unsubscribe line) — to their own connected Gmail address,
// so the compliance footer and the sender identity can be checked before anything reaches a prospect.
//
// Safety shape:
// - The only recipient is the connected Gmail account's own address (via gmailStatus), read at send time.
//   There is no recipient parameter, so no caller can aim a test at anyone else.
// - The draft row is never written: status, approved_hash and sent_at stay exactly as they were, and nothing
//   is recorded as sent to the prospect. Test sends do not count toward the daily send cap.
// - The unsubscribe link is real in form (same /api/unsubscribe URL) but its token is signed under a
//   test-only key domain: neither the marked token nor the token with its marker stripped can resolve to
//   a message, so a test click — or a leaked test email — suppresses nobody.
// - This module holds no SQL of its own: the draft is read through listMessages and the account through
//   gmailStatus (the pg-port audit keeps raw-handle modules registered in lib/db/pg-port-status.ts).
import type Database from 'better-sqlite3'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { getMasterKey } from '../secrets.ts'
import { buildMime, toBase64Url } from '../gmail/mime.ts'
import { GmailError, GmailSendError, confirmedSendResult, getAccessTokenBound, gmailSend, gmailStatus, isConnectionReplaced, markNeedsReconnectBound, type OAuthDeps } from '../gmail/oauth.ts'
import { composeBody, getSettings, listMessages, OutreachError } from './service.ts'
import { recheckSendAuthority } from './send-authority.ts'

export interface TestSendDeps extends OAuthDeps { baseUrl?: string; sendFn?: typeof gmailSend; master?: Buffer }

// A test token is signed under its own key domain ('dazl-unsubscribe-test-v1'), never a wrapped
// production token (Qodo): the marked form fails readUnsubToken's shape check, and stripping the "t."
// marker leaves a signature made under the test key, which the production key check rejects. Neither
// form can suppress the prospect, even from a leaked or forwarded test email.
const testUnsubKey = (master: Buffer) => createHmac('sha256', master).update('dazl-unsubscribe-test-v1').digest()
export function unsubTestToken(messageId: string, master = getMasterKey()): string {
  return `t.${messageId}.${createHmac('sha256', testUnsubKey(master)).update(messageId).digest('hex').slice(0, 32)}`
}
export function isTestUnsubToken(token: string, master = getMasterKey()): boolean {
  if (!token.startsWith('t.')) return false
  const [id, sig] = token.slice(2).split('.')
  if (!id || !sig || !/^[a-f0-9]{24}$/.test(id) || !/^[a-f0-9]{32}$/.test(sig)) return false
  const want = createHmac('sha256', testUnsubKey(master)).update(id).digest('hex').slice(0, 32)
  return timingSafeEqual(Buffer.from(sig), Buffer.from(want))
}

const baseUrl = (d: TestSendDeps) => (d.baseUrl ?? process.env.PUBLIC_BASE_URL ?? 'https://dazl.ai').replace(/\/$/, '')

// Sends the draft's final form to the account's own Gmail address. Returns that address.
// Refusals reuse the send path's error codes: not_found, sender_identity_missing, gmail_not_connected,
// gmail_reconnect_needed, gmail_rejected, gmail_rate_limited. daily_cap is NOT among them (tests are uncapped).
export async function sendTestToSelf(db: Database.Database, tenantId: string, id: string, d: TestSendDeps = {}): Promise<string> {
  const m = listMessages(db, tenantId, d).find(x => x.id === id)
  if (!m) throw new OutreachError('not_found')
  const settings = getSettings(db, tenantId)
  if (!settings) throw new OutreachError('sender_identity_missing')
  const acct = gmailStatus(db, tenantId)
  if (!acct) throw new OutreachError('gmail_not_connected')
  let bound: { token: string; refreshCt: string }
  try {
    bound = await getAccessTokenBound(db, tenantId, d)
  } catch (e) {
    throw new OutreachError(e instanceof GmailError && e.kind === 'reconnect' ? 'gmail_reconnect_needed' : isConnectionReplaced(e, db, tenantId) ? 'connection_replaced' : 'gmail_unavailable')
  }
  // The token wait is long enough for the draft to be edited or the connection to be replaced (Qodo).
  // Like the send path: reread and recheck before anything is handed to Gmail, and refuse rather than
  // test words that are no longer the saved words, or send through a connection that is no longer the
  // one this token was minted from. 'suppressed' from the recheck governs prospect outreach; a test to
  // the account's own address is not outreach, so it does not refuse the test.
  const again = listMessages(db, tenantId, d).find(x => x.id === id)
  if (!again) throw new OutreachError('not_found')
  if (again.subject !== m.subject || again.body !== m.body || (again.status !== 'draft' && again.status !== 'approved')) throw new OutreachError('draft_changed')
  const auth = recheckSendAuthority(db, tenantId, { sender: acct.email, to: acct.email, now: d.now ?? Math.floor(Date.now() / 1000), expectRefreshCt: bound.refreshCt })
  if (auth === 'gmail_not_connected') throw new OutreachError('gmail_not_connected')
  if (auth === 'connection_replaced' || auth === 'sender_changed') throw new OutreachError('connection_replaced')
  if (auth === 'authority_unreadable') throw new OutreachError('gmail_unavailable')
  const token = bound.token
  const master = d.master ?? getMasterKey()
  const unsubUrl = `${baseUrl(d)}/api/unsubscribe?t=${unsubTestToken(id, master)}`
  const raw = toBase64Url(buildMime({
    fromName: settings.sender_name, fromEmail: acct.email, to: acct.email, subject: `[Test] ${again.subject}`,
    body: composeBody(again.body, settings, unsubUrl), messageId: `dazl.test.${id}@${acct.email.split('@')[1]}`, unsubscribeUrl: unsubUrl, date: new Date(),
  }))
  try {
    confirmedSendResult(await (d.sendFn ?? gmailSend)(token, raw, d.fetchImpl))
  } catch (e) {
    if (e instanceof GmailSendError) {
      // A 401/403 here means the grant is dead: mark the account needs_reconnect now, scoped to the
      // connection generation this token was minted from, so a replacement connection is never marked
      // by this stale send. The caller is told either way.
      if (e.status === 401 || e.status === 403) { markNeedsReconnectBound(db, tenantId, bound.refreshCt); throw new OutreachError('gmail_reconnect_needed') }
      if (e.status === 400 || e.status === 404) throw new OutreachError('gmail_rejected')
      if (e.status === 429) throw new OutreachError('gmail_rate_limited')
    }
    throw new OutreachError('send_outcome_unknown')
  }
  return acct.email
}
