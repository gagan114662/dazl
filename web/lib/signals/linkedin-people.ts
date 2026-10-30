// LinkedIn person-level signals, reworked (Instinct's brief on #192): a NARROW, OFF-BY-DEFAULT consumer of an injected, authorized transport. Dazl itself does not log in to LinkedIn,
// does not use or store a member session (li_at / JSESSIONID), does not probe LinkedIn endpoints, and never posts, likes, messages or sends connection requests. The only way data
// reaches this module is through a `LinkedInTransport` that a reviewed integration provides (an official/partner API the tenant is authorised for, or the tenant's own consented data
// export). With no transport (the default) nothing leaves the process and nothing is collected: the run reports `unavailable`, never "no people".
//
// Rules enforced here whatever the transport is:
//   - OFF unless ADVANCED_LINKEDIN_PEOPLE=1 AND the tenant's LinkedIn consent is on AND a transport is injected.
//   - Per-request budgets: at most MAX_REQUESTS_PER_RUN requests per scan, MAX_REQUESTS_PER_HOUR per tenant, MAX_ITEMS per request, bounded text; a request that times out is an error, not a retry.
//   - Tenant separation: every request carries the tenant id, budgets and cooldowns are per tenant, and one tenant's throttling never affects another.
//   - Stop on throttling or a challenge/unauthorised answer: the run stops at once (no retry, no second request), the tenant is put on a cooldown (COOLDOWN_S) and later runs report `cooldown`.
//   - Items must be public profile URLs (https://www.linkedin.com/in/<slug>); they are login-walled evidence, so leads stay in the review lane (login_required) and are never emailed automatically.
// Db layer (SQLite + Postgres): consent, competitors, budgets and the audit all go through the Db interface.
import type { Db } from '../db/client.ts'
import type { Evidence } from '../sources/types.ts'
import { writeAudit } from '../connectors/store.ts'
import { connectorId } from '../advanced/config.ts'
import { readConsent } from '../advanced/index.ts'
import { readCompetitors } from './competitor-reddit.ts'

const ID = connectorId('linkedin')
export const PEOPLE_CONNECTOR = 'adv:linkedin-people'
export const MAX_REQUESTS_PER_RUN = 2
export const MAX_REQUESTS_PER_HOUR = 3
export const MAX_ITEMS = 25
export const COOLDOWN_S = 24 * 3600
const TIMEOUT_MS = 20_000
export type LinkedInItem = Evidence & { login_walled: boolean }

export interface TransportRequest { kind: 'people' | 'engagers'; query: string; tenantId: string; maxItems: number; signal: AbortSignal }
export type TransportResult = { status: 'ok'; items: { url: string; title: string; quote: string; date: string | null }[] } | { status: 'throttled' | 'challenge' | 'unauthorized' | 'error' }
export interface LinkedInTransport { fetch(req: TransportRequest): Promise<TransportResult> }

// Its own switch (not the session-worker flags: no worker is involved), and the global advanced kill switch still applies.
export const peopleEnabled = (env: Record<string, string | undefined> = process.env) => env.ADVANCED_LINKEDIN_PEOPLE === '1' && env.ADVANCED_KILL !== '1'

export function linkedinQueries(icp: { who: string[]; where: string[]; industries: string[] }, competitors: string[], budget: number): { kind: 'people' | 'engagers'; query: string }[] {
  const qs: { kind: 'people' | 'engagers'; query: string }[] = []
  const role = icp.who[0]?.trim(); const place = icp.where[0]?.trim()
  // One people search first (any business has buyers to find), then competitor engagement with what is left.
  if (role) qs.push({ kind: 'people', query: [role, place].filter(Boolean).join(' ').slice(0, 200) })
  for (const c of competitors) qs.push({ kind: 'engagers', query: c.slice(0, 200) })
  return qs.slice(0, Math.max(0, budget))
}

const PROFILE = /^https:\/\/www\.linkedin\.com\/in\/[A-Za-z0-9%_-]{2,100}\/?$/
async function requestsLastHour(db: Db, tenantId: string, now: number): Promise<number> {
  const r = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM connector_audit WHERE tenant_id = ? AND connector = ? AND status IN ('ok','empty','error') AND created_at >= ?", [tenantId, ID, now - 3600])
  return Number(r?.n ?? 0)
}
async function coolingDown(db: Db, tenantId: string, now: number): Promise<boolean> {
  const r = await db.get<{ at: number }>("SELECT MAX(created_at) AS at FROM connector_audit WHERE tenant_id = ? AND connector = ? AND status LIKE 'stopped_%'", [tenantId, ID])
  return r?.at != null && now - Number(r.at) < COOLDOWN_S
}

export async function collectLinkedInPeople(db: Db, tenantId: string, jobId: string, icp: { who: string[]; where: string[]; industries: string[] }, deps: { transport?: LinkedInTransport; env?: Record<string, string | undefined>; now?: number } = {}): Promise<LinkedInItem[]> {
  const env = deps.env ?? process.env, now = deps.now ?? Math.floor(Date.now() / 1000)
  const skip = async (status: string) => { await writeAudit(db, { tenantId, connector: PEOPLE_CONNECTOR, jobId, lookup: 'linkedin people', status, results: 0 }); return [] as LinkedInItem[] }
  if (!peopleEnabled(env)) return skip('disabled')
  if (!(await readConsent(db, tenantId, 'linkedin'))) return skip('no_consent')
  if (!deps.transport) return skip('unavailable')                // no authorised transport: nothing is requested, and this is not "zero people"
  if (await coolingDown(db, tenantId, now)) return skip('cooldown')
  const left = Math.min(MAX_REQUESTS_PER_RUN, MAX_REQUESTS_PER_HOUR - (await requestsLastHour(db, tenantId, now)))
  const queries = linkedinQueries(icp, await readCompetitors(db, tenantId), left)
  if (queries.length === 0) return skip('rate_limited')
  const out: LinkedInItem[] = []
  for (const q of queries) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
    let res: TransportResult
    try { res = await deps.transport.fetch({ kind: q.kind, query: q.query, tenantId, maxItems: MAX_ITEMS, signal: ctl.signal }) } catch { res = { status: 'error' } } finally { clearTimeout(timer) }
    const lookup = `${q.kind}:${q.query}`
    if (res.status !== 'ok') {
      if (res.status === 'error') { await writeAudit(db, { tenantId, connector: ID, jobId, lookup, status: 'error', results: 0 }); continue }
      // throttled / challenge / unauthorised: stop at once - no retry, no further request - and a cooldown for THIS tenant only.
      await writeAudit(db, { tenantId, connector: ID, jobId, lookup, status: `stopped_${res.status}`, results: 0 })
      break
    }
    const items = res.items.slice(0, MAX_ITEMS).filter(it => PROFILE.test(it.url))
    await writeAudit(db, { tenantId, connector: ID, jobId, lookup, status: items.length ? 'ok' : 'empty', results: items.length })
    for (const it of items) out.push({ source: ID, url: it.url, title: it.title.slice(0, 120), quote: it.quote.slice(0, 300), date: it.date, login_walled: true })
  }
  return out
}
