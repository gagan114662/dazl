// LinkedIn person-level signals: a NARROW, OFF-BY-DEFAULT consumer of an INJECTED, AUTHORISED transport (#192 rework). Dazl does not log in to LinkedIn, hold or use any member session
// or cookie, probe LinkedIn endpoints, or post, like, message or send connection requests. Data reaches this module only through a `LinkedInTransport` that a reviewed integration
// provides; with none (the default, and production today) nothing is requested and the run reports `unavailable`, never "no people". Source, allowed fields and licensing
// feasibility: docs/linkedin-people-source.md.
//
// Controls enforced here whatever the transport is:
//   GATES   every gate is re-checked before EVERY request, not only at the start: ADVANCED_CONNECTORS=1, no ADVANCED_KILL, ADVANCED_LINKEDIN=1, ADVANCED_LINKEDIN_PEOPLE=1, the tenant's
//           LinkedIn consent, and the tenant's own connector switch (a disabled `adv:linkedin` connector row). Any one off stops the run.
//   BUDGET  one atomic per-tenant request budget shared with every other LinkedIn consumer (lib/advanced/request-budget.ts): MAX_REQUESTS_PER_HOUR across all of them, at most
//           MAX_REQUESTS_PER_RUN here. A reservation is made before the call and is never refunded.
//   CALLS   one transport call = exactly ONE upstream request (one page, no pagination, no fan-out). A transport that reports more than one upstream request breaks the contract: its
//           result is discarded and the run stops with a cooldown. At most MAX_ITEMS items are taken from that single page.
//   DEADLINE the call is raced against a hard deadline; the signal is aborted, and any result that arrives after the deadline is DISCARDED even if the transport ignored the abort.
//   STOP    throttled / challenge / unauthorised: stop at once, no retry, and a COOLDOWN_S cooldown for that tenant only.
//   OUTPUT  only public profile URLs (https://www.linkedin.com/in/<slug>), deduplicated across queries and within a result; bounded text; leads stay in the review lane
//           (login_required) and are never emailed automatically.
// Db layer (SQLite + Postgres).
import type { Db } from '../db/client.ts'
import type { Evidence } from '../sources/types.ts'
import { writeAudit } from '../connectors/store.ts'
import { connectorId } from '../advanced/config.ts'
import { readConsent } from '../advanced/index.ts'
import { reserveRequest } from '../advanced/request-budget.ts'
import { readCompetitors } from './competitor-reddit.ts'

const ID = connectorId('linkedin')
export const PEOPLE_CONNECTOR = 'adv:linkedin-people'
export const MAX_REQUESTS_PER_RUN = 2
export const MAX_REQUESTS_PER_HOUR = 3
export const MAX_ITEMS = 25
export const COOLDOWN_S = 24 * 3600
export const DEADLINE_MS = 20_000
export type LinkedInItem = Evidence & { login_walled: boolean }

export interface TransportRequest { kind: 'people' | 'engagers'; query: string; tenantId: string; maxItems: number; signal: AbortSignal }
// upstream_requests: how many upstream requests this call made. The contract is exactly one; anything else is a violation.
export type TransportResult = { status: 'ok'; items: { url: string; title: string; quote: string; date: string | null }[]; upstream_requests?: number } | { status: 'throttled' | 'challenge' | 'unauthorized' | 'error' }
export interface LinkedInTransport { fetch(req: TransportRequest): Promise<TransportResult> }

// The environment gates (read fresh every time). The per-tenant gates (consent, connector switch) are checked separately.
export function gatesOpen(env: Record<string, string | undefined> = process.env): boolean {
  return env.ADVANCED_CONNECTORS === '1' && env.ADVANCED_KILL !== '1' && env.ADVANCED_LINKEDIN === '1' && env.ADVANCED_LINKEDIN_PEOPLE === '1'
}
export const peopleEnabled = gatesOpen

export function linkedinQueries(icp: { who: string[]; where: string[]; industries: string[] }, competitors: string[], budget: number): { kind: 'people' | 'engagers'; query: string }[] {
  const qs: { kind: 'people' | 'engagers'; query: string }[] = []
  const role = icp.who[0]?.trim(); const place = icp.where[0]?.trim()
  // One people search first (any business has buyers to find), then competitor engagement with what is left.
  if (role) qs.push({ kind: 'people', query: [role, place].filter(Boolean).join(' ').slice(0, 200) })
  for (const c of competitors) qs.push({ kind: 'engagers', query: c.slice(0, 200) })
  return qs.slice(0, Math.max(0, budget))
}

const PROFILE = /^https:\/\/www\.linkedin\.com\/in\/[A-Za-z0-9%_-]{2,100}\/?$/
export const profileKey = (u: string) => u.toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '')
async function coolingDown(db: Db, tenantId: string, now: number): Promise<boolean> {
  const r = await db.get<{ at: number }>("SELECT MAX(created_at) AS at FROM connector_audit WHERE tenant_id = ? AND connector = ? AND status LIKE 'stopped_%'", [tenantId, ID])
  return r?.at != null && now - Number(r.at) < COOLDOWN_S
}
// The tenant's own switch for this connector: a row that is disabled stops it. (No session or credential is read or needed.)
async function connectorDisabled(db: Db, tenantId: string): Promise<boolean> {
  const r = await db.get<{ enabled: number }>('SELECT enabled FROM tenant_connectors WHERE tenant_id = ? AND connector = ?', [tenantId, ID])
  return !!r && Number(r.enabled) === 0
}
async function gateStatus(db: Db, tenantId: string, env: Record<string, string | undefined>): Promise<string | null> {
  if (!gatesOpen(env)) return 'disabled'
  if (!(await readConsent(db, tenantId, 'linkedin'))) return 'no_consent'
  if (await connectorDisabled(db, tenantId)) return 'connector_disabled'
  return null
}

export async function collectLinkedInPeople(db: Db, tenantId: string, jobId: string, icp: { who: string[]; where: string[]; industries: string[] }, deps: { transport?: LinkedInTransport; env?: Record<string, string | undefined>; now?: number; deadlineMs?: number } = {}): Promise<LinkedInItem[]> {
  const envNow = () => deps.env ?? process.env, now = deps.now ?? Math.floor(Date.now() / 1000), deadlineMs = deps.deadlineMs ?? DEADLINE_MS
  const skip = async (status: string) => { await writeAudit(db, { tenantId, connector: PEOPLE_CONNECTOR, jobId, lookup: 'linkedin people', status, results: 0 }); return [] as LinkedInItem[] }
  const g0 = await gateStatus(db, tenantId, envNow()); if (g0) return skip(g0)
  if (!deps.transport) return skip('unavailable')                // no authorised transport: nothing is requested, and this is not "zero people"
  if (await coolingDown(db, tenantId, now)) return skip('cooldown')
  const queries = linkedinQueries(icp, await readCompetitors(db, tenantId), MAX_REQUESTS_PER_RUN)
  const out: LinkedInItem[] = [], seen = new Set<string>(); let made = 0
  for (const q of queries) {
    // Every gate again, immediately before THIS request: a switch flipped mid-run stops the run.
    const g = await gateStatus(db, tenantId, envNow()); if (g) { await skip(g); break }
    if (!(await reserveRequest(db, tenantId, ID, MAX_REQUESTS_PER_HOUR, 'people', now))) { if (made === 0) await skip('rate_limited'); else await skip('rate_limited_mid_run'); break }
    made++
    const lookup = `${q.kind}:${q.query}`
    const ctl = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined
    // Hard deadline: raced, so a transport that ignores the abort cannot hold the run or have a late answer accepted.
    const res = await Promise.race([
      deps.transport.fetch({ kind: q.kind, query: q.query, tenantId, maxItems: MAX_ITEMS, signal: ctl.signal }).catch((): TransportResult => ({ status: 'error' })),
      new Promise<'deadline'>(r => { timer = setTimeout(() => { ctl.abort(); r('deadline') }, deadlineMs) }),
    ]).finally(() => clearTimeout(timer))
    if (res === 'deadline') { await writeAudit(db, { tenantId, connector: ID, jobId, lookup, status: 'error', results: 0 }); continue }   // the late result, if any, is dropped
    if (res.status !== 'ok') {
      if (res.status === 'error') { await writeAudit(db, { tenantId, connector: ID, jobId, lookup, status: 'error', results: 0 }); continue }
      await writeAudit(db, { tenantId, connector: ID, jobId, lookup, status: `stopped_${res.status}`, results: 0 })     // throttled / challenge / unauthorised
      break
    }
    if ((res.upstream_requests ?? 1) !== 1) { await writeAudit(db, { tenantId, connector: ID, jobId, lookup, status: 'stopped_contract', results: 0 }); break }   // more than one upstream request per call: contract broken
    let added = 0
    for (const it of res.items.slice(0, MAX_ITEMS)) {
      if (!PROFILE.test(it.url)) continue
      const k = profileKey(it.url); if (seen.has(k)) continue        // the same profile from another query (or twice in one answer) is one lead
      seen.add(k); added++
      out.push({ source: ID, url: it.url, title: it.title.slice(0, 120), quote: it.quote.slice(0, 300), date: it.date, login_walled: true })
    }
    await writeAudit(db, { tenantId, connector: ID, jobId, lookup, status: added ? 'ok' : 'empty', results: added })
  }
  return out
}
