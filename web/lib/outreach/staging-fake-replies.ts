// TEST-ONLY staging fake reply source (#413 live check without a real Gmail client). ON only when DAZL_ENV=staging, Gmail is
// the stub (lib/staging.ts) AND DAZL_STAGING_FAKE_REPLIES=1; inert everywhere else (production never reads the flag, and a
// real staging Gmail transport never uses it). It stands in for Gmail's read endpoints so the REAL reply sync, run by the
// REAL tick, can be watched end to end at $0: ingest, suppression, the refused second send and the stale-safety hold.
//
// What a thread "contains" is decided by the address the first touch went to (synthetic staging recipients only):
//   - local part contains "fake-optout"     -> one reply from that address: "Please unsubscribe me." (an opt-out)
//   - local part contains "fake-syncerror"  -> Gmail answers 500 for that thread (a partial sync: freshness unknown)
//   - anything else                         -> no reply in the thread
// The bounded delivery-notice search returns nothing. Any other Gmail call (e.g. a send) throws: nothing here can send.
import { isStaging, gmailIsStubbed, type Env } from '../staging.ts'

export const stagingFakeReplies = (env: Env = process.env): boolean =>
  isStaging(env) && gmailIsStubbed(env) && env.DAZL_STAGING_FAKE_REPLIES === '1'

export const FAKE_OPTOUT_TEXT = 'Please unsubscribe me.'
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
const local = (email: string) => (email.split('@')[0] ?? '').toLowerCase()

// The caller (replies.ts syncReplies) supplies the lookups on its own store, so this file never touches the database.
export interface FakeReplyLookup {
  threadOf: (gmailId: string) => { thread_id: string | null } | undefined // undefined: no such sent message
  sentTo: (threadOrGmailId: string) => { to_email: string; sent_at: number | null } | undefined
}
export function stagingFakeGmail(look: FakeReplyLookup): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const u = String(input instanceof Request ? input.url : input)
    if (!u.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/')) throw new Error('staging_fake_replies: unexpected request')
    const path = u.slice('https://gmail.googleapis.com/gmail/v1/users/me/'.length)
    if (path.startsWith('messages?q=')) return json({ messages: [] })
    const minimal = path.match(/^messages\/([^?/]+)\?format=minimal$/)
    if (minimal) {
      const t = look.threadOf(decodeURIComponent(minimal[1]))
      return t ? json({ id: minimal[1], threadId: t.thread_id ?? minimal[1] }) : json({ error: 'not_found' }, 404)
    }
    const thread = path.match(/^threads\/([^?/]+)\?format=full$/)
    if (!thread) throw new Error('staging_fake_replies: unexpected Gmail call')
    const id = decodeURIComponent(thread[1])
    const row = look.sentTo(id)
    if (!row) return json({ error: 'not_found' }, 404)
    const who = local(row.to_email)
    if (who.includes('fake-syncerror')) return json({ error: 'backend' }, 500)
    if (!who.includes('fake-optout')) return json({ id, messages: [] })
    const at = ((row.sent_at ?? Math.floor(Date.now() / 1000)) + 60) * 1000
    return json({ id, messages: [{
      id: `fake-optout-${id}`, threadId: id, internalDate: String(at),
      payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: row.to_email }, { name: 'Subject', value: 'Re: your email' }], body: { data: Buffer.from(FAKE_OPTOUT_TEXT).toString('base64url') } },
    }] })
  }) as typeof fetch
}
