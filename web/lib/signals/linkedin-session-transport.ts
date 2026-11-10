// The SIGNED-IN SESSION LinkedIn transport (#192, owner-authorised 2026-11-06; confirmed 2026-11-09 4:59pm via Quest with three rules: a separate
// throwaway account, a human pace, off by default; the owner accepted the account-ban risk). It reads, through the session worker, competitor posts
// and the commenters / reactors of one post at a time, using the LinkedIn session cookie stored (encrypted) as the tenant's own `adv:linkedin` connector credential. Operationally
// that session belongs to ONE designated throwaway account; never a person's own account.
//
// OFF unless ALL of: LINKEDIN_SESSION_TRANSPORT=1; LINKEDIN_SESSION_TENANTS names EXACTLY ONE tenant (the operator's dedicated tenant that holds the throwaway session; a
// list of two or more turns the transport off, because the hourly/daily caps are per tenant and two tenants would multiply them for one account); LINKEDIN_SESSION_ACCOUNT
// names the dedicated throwaway account (a non-secret label such as its sign-in email: the operator's attestation that the stored session is that account and nobody's own;
// a value that looks like a cookie is refused); and the session worker settings. Every gate, cap, deadline, stop and cooldown of linkedin-people.ts applies on top. Read-only: the worker only issues GETs; nothing is posted, liked, messaged or connected. One call = one worker request = one upstream GET.
// The cookie is never logged and is sent only to the session worker, over its bearer-token API.
import type { Db } from '../db/client.ts'
import { readEnabledCredential } from '../connectors/store.ts'
import { connectorId } from '../advanced/config.ts'
import type { LinkedInTransport, TransportRequest, TransportResult } from './linkedin-people.ts'

// Why the session transport is not usable for this tenant, or null when it is. 'off' (the flag is not set) is the default and is not recorded.
export type SessionProblem = 'off' | 'no_worker' | 'no_account' | 'multiple_tenants' | 'not_allowlisted'
export function sessionTransportProblem(tenantId: string, env: Record<string, string | undefined> = process.env): SessionProblem | null {
  if (env.LINKEDIN_SESSION_TRANSPORT !== '1') return 'off'
  if (!env.ADVANCED_WORKER_URL || !env.ADVANCED_WORKER_TOKEN) return 'no_worker'
  const account = (env.LINKEDIN_SESSION_ACCOUNT ?? '').trim()
  if (account.length < 3 || account.length > 200 || /li_at|jsessionid|[;=\s]/i.test(account)) return 'no_account'
  const tenants = [...new Set((env.LINKEDIN_SESSION_TENANTS ?? '').split(',').map(s => s.trim()).filter(Boolean))]
  if (tenants.length > 1) return 'multiple_tenants'
  return tenants[0] === tenantId ? null : 'not_allowlisted'
}
// The designated throwaway session is spent ONLY through the paced, capped, challenge-stopping transport: when the flag is on and this tenant is named in the allowlist (even a
// misconfigured multi-tenant list, which fails closed), the older un-paced `adv:linkedin` /fetch reader must not use the same cookie (#949 review).
export function sessionCookieReserved(tenantId: string, env: Record<string, string | undefined> = process.env): boolean {
  return env.LINKEDIN_SESSION_TRANSPORT === '1' && (env.LINKEDIN_SESSION_TENANTS ?? '').split(',').map(s => s.trim()).includes(tenantId)
}
export function sessionTransportEnabled(tenantId: string, env: Record<string, string | undefined> = process.env): boolean {
  return sessionTransportProblem(tenantId, env) === null
}

// A worker reply, streamed with a byte cap: an oversized body is never buffered whole (#949 review). null = over the cap.
export const MAX_REPLY_BYTES = 1_000_000
export async function readReply(res: Response, max = MAX_REPLY_BYTES): Promise<string | null> {
  if (!res.body) return ''
  const reader = res.body.getReader(), chunks: Uint8Array[] = []; let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.byteLength
    if (n > max) { try { await reader.cancel() } catch { /* closed */ } return null }
    chunks.push(value)
  }
  const buf = new Uint8Array(n); let at = 0
  for (const c of chunks) { buf.set(c, at); at += c.byteLength }
  return new TextDecoder().decode(buf)
}

// The worker's failure outcome -> the reader's stop status. Unknown outcomes are an error (audited, never zero results).
export function mapOutcome(outcome: unknown): TransportResult {
  return outcome === 'auth_failed' ? { status: 'unauthorized' } : outcome === 'throttled' ? { status: 'throttled' } : outcome === 'challenge' ? { status: 'challenge' } : { status: 'error' }
}

const ITEM_URL = /^https:\/\/[^\s]{4,480}$/
export function parseReply(body: unknown, maxItems: number): TransportResult {
  const o = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  if (!o || o.error != null || !Array.isArray(o.items) || o.outcome === 'unsupported') return { status: 'error' }
  const items = o.items.slice(0, maxItems).flatMap(it => {
    const x = it as Record<string, unknown> | null
    if (!x || typeof x.url !== 'string' || !ITEM_URL.test(x.url) || typeof x.title !== 'string' || typeof x.quote !== 'string') return []
    return [{ url: x.url, title: x.title.slice(0, 200), quote: x.quote.slice(0, 300), date: typeof x.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.date) ? x.date : null }]
  })
  return { status: 'ok', items, upstream_requests: o.upstream_requests === undefined ? 1 : Number(o.upstream_requests) }
}

export function linkedinSessionTransport(db: Db, deps: { env?: Record<string, string | undefined>; master?: Buffer; fetchImpl?: typeof fetch } = {}): LinkedInTransport {
  const env = deps.env ?? process.env, fetchImpl = deps.fetchImpl ?? fetch
  return {
    session: true,
    async fetch(req: TransportRequest): Promise<TransportResult> {
      if (req.kind !== 'posts' && req.kind !== 'commenters' && req.kind !== 'reactors') return { status: 'error' }
      if (!sessionTransportEnabled(req.tenantId, env)) return { status: 'unauthorized' }
      const session = await readEnabledCredential(db, req.tenantId, connectorId('linkedin'), deps.master)
      if (!session) return { status: 'unauthorized' }          // no stored session: nothing is requested
      // Both legs go to the worker's session routes, which inspect redirects and classify login walls, checkpoints, restrictions, 999 and 429 (#949 review:
      // the generic /fetch adapter folds those into a retryable error).
      const [path, payload] = req.kind === 'posts'
        ? ['/linkedin/posts', { query: req.query.slice(0, 300), session }]
        : ['/linkedin/engagers', { kind: req.kind, post: req.query.slice(0, 300), session }]
      try {
        const res = await fetchImpl(`${env.ADVANCED_WORKER_URL!.replace(/\/$/, '')}${path}`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.ADVANCED_WORKER_TOKEN}` },
          body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.any([req.signal, AbortSignal.timeout(45_000)]),
        })
        const text = await readReply(res)
        if (text === null) return { status: 'error' }
        const body: unknown = JSON.parse(text)
        if (!res.ok) return mapOutcome((body as { outcome?: unknown } | null)?.outcome)
        return parseReply(body, req.maxItems)
      } catch { return { status: 'error' } }
    },
  }
}
