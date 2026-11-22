// The SIGNED-IN SESSION LinkedIn transport (#192, owner-authorised 2026-11-06; confirmed 2026-11-09 4:59pm via Quest with three rules: a separate
// throwaway account, a human pace, off by default; the owner accepted the account-ban risk). It reads, through the session worker, competitor posts
// and the commenters / reactors of one post at a time, using the LinkedIn session cookie stored (encrypted) as the tenant's own `adv:linkedin` connector credential. Operationally
// that session belongs to ONE designated throwaway account; never a person's own account.
//
// OFF: see sessionTransportProblem below (server cookie replay removed, #1122).
// The cookie is never logged and is sent only to the session worker, over its bearer-token API.
import type { Db } from '../db/client.ts'
import { readEnabledCredential } from '../connectors/store.ts'
import { connectorId } from '../advanced/config.ts'
import type { LinkedInTransport, TransportRequest, TransportResult } from './linkedin-people.ts'

// Owner brief 2026-11-22 (docs/launch-brief.md Step 4, #1122): LinkedIn reads run ONLY in the user's own browser (the dazl Connect extension,
// lib/linkedin-tasks). The server never replays a LinkedIn session cookie: this transport is always off, and the operator allowlist / throwaway-account
// settings it used are gone. Kept as a type-stable stub until the session worker code is removed in a later PR.
export type SessionProblem = 'off'
export function sessionTransportProblem(tenantId?: string, env?: Record<string, string | undefined>): SessionProblem { void tenantId; void env; return 'off' }
export function sessionCookieReserved(tenantId?: string, env?: Record<string, string | undefined>): boolean { void tenantId; void env; return false }
export function sessionTransportEnabled(tenantId?: string, env?: Record<string, string | undefined>): boolean { void tenantId; void env; return false }

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
