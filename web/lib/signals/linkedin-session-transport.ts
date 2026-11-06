// The SIGNED-IN SESSION LinkedIn transport (#192, owner-authorised 2026-11-06; the owner accepted the account-ban risk). It reads, through the session worker, competitor posts
// and the commenters / reactors of one post at a time, using the LinkedIn session cookie stored (encrypted) as the tenant's own `adv:linkedin` connector credential. Operationally
// that session belongs to ONE designated throwaway account; never a person's own account.
//
// OFF unless BOTH: LINKEDIN_SESSION_TRANSPORT=1 and the tenant id is listed in LINKEDIN_SESSION_TENANTS (comma separated). Every gate, cap, deadline, stop and cooldown of
// linkedin-people.ts applies on top. Read-only: the worker only issues GETs; nothing is posted, liked, messaged or connected. One call = one worker request = one upstream GET.
// The cookie is never logged and is sent only to the session worker, over its bearer-token API.
import type { Db } from '../db/client.ts'
import { readEnabledCredential } from '../connectors/store.ts'
import { connectorId } from '../advanced/config.ts'
import type { LinkedInTransport, TransportRequest, TransportResult } from './linkedin-people.ts'

export function sessionTransportEnabled(tenantId: string, env: Record<string, string | undefined> = process.env): boolean {
  if (env.LINKEDIN_SESSION_TRANSPORT !== '1' || !env.ADVANCED_WORKER_URL || !env.ADVANCED_WORKER_TOKEN) return false
  return (env.LINKEDIN_SESSION_TENANTS ?? '').split(',').map(s => s.trim()).filter(Boolean).includes(tenantId)
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
      const [path, payload] = req.kind === 'posts'
        ? ['/fetch', { platform: 'linkedin', query: req.query.slice(0, 300), session }]
        : ['/linkedin/engagers', { kind: req.kind, post: req.query.slice(0, 300), session }]
      try {
        const res = await fetchImpl(`${env.ADVANCED_WORKER_URL!.replace(/\/$/, '')}${path}`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.ADVANCED_WORKER_TOKEN}` },
          body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.any([req.signal, AbortSignal.timeout(45_000)]),
        })
        const text = await res.text()
        if (text.length > 1_000_000) return { status: 'error' }
        const body: unknown = JSON.parse(text)
        if (!res.ok) return mapOutcome((body as { outcome?: unknown } | null)?.outcome)
        return parseReply(body, req.maxItems)
      } catch { return { status: 'error' } }
    },
  }
}
