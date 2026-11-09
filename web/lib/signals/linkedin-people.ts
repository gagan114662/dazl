// LinkedIn person-level signals: a NARROW, OFF-BY-DEFAULT consumer of an INJECTED transport (#192). This module never logs in, never posts, likes, messages or sends connection
// requests, and holds no cookie itself. Data reaches it only through a `LinkedInTransport`; with none (the default) nothing is requested and the run reports `unavailable`, never
// "no people". Two transports exist: a reviewed third-party one injected by the caller, and the owner-authorised SIGNED-IN SESSION transport (linkedin-session-transport.ts,
// 2026-11-06), which reads the commenters / reactors of competitors' posts through the session of a designated throwaway account and is off unless its own flag and tenant
// allowlist say otherwise. Source, allowed fields and licensing: docs/linkedin-people-source.md.
//
// Controls enforced here whatever the transport is:
//   GATES   every gate is re-checked before EVERY request, not only at the start: ADVANCED_CONNECTORS=1, no ADVANCED_KILL, ADVANCED_LINKEDIN=1, ADVANCED_LINKEDIN_PEOPLE=1, the tenant's
//           LinkedIn consent, and the tenant's own connector switch (a disabled `adv:linkedin` connector row). Any one off stops the run.
//   BUDGET  one atomic per-tenant request budget shared with every other LinkedIn consumer (lib/advanced/request-budget.ts): MAX_REQUESTS_PER_HOUR across all of them, at most
//           MAX_REQUESTS_PER_RUN here. A reservation is made before the call and is never refunded.
//   CALLS   one transport call = exactly ONE upstream request (one page, no pagination, no fan-out). A transport that reports more than one upstream request breaks the contract: its
//           result is discarded and the run stops with a cooldown. At most MAX_ITEMS items are taken from that single page.
//   DEADLINE the call is raced against a hard deadline; the signal is aborted, and any result that arrives after the deadline is DISCARDED even if the transport ignored the abort.
//   STOP    throttled / challenge / unauthorised: stop at once, no retry, and a COOLDOWN_S cooldown for that tenant only. The stop is audited and reported (deps.onStop).
//   SESSION a transport that reads posts / commenters / reactors (the signed-in session transport) also gets: a DAILY cap (LINKEDIN_ENGAGERS_DAILY_CAP, default 6, atomic, its own
//           'adv:linkedin:day' key), a per-run cap (LINKEDIN_SESSION_PER_RUN, default 3, never above the hourly cap), and a human pace between its requests
//           (LINKEDIN_SESSION_GAP_MS, default 20 s plus up to 50% jitter). Its plan per competitor: one post search, then the commenters and the reactors of the first post found.
//   OWNER   deps.beforeRequest (the scan runner's ownership/deadline check) runs immediately before EVERY reservation: a scan that was cancelled, reaped or timed out
//           while an earlier request was in flight starts no new LinkedIn request. Its throw is recorded ('scan_stopped') and re-thrown to the runner.
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

// 'people' / 'engagers': a reviewed third-party transport. 'posts' / 'commenters' / 'reactors': the signed-in session transport (query = competitor name for 'posts', a post URL otherwise).
export type TransportKind = 'people' | 'engagers' | 'posts' | 'commenters' | 'reactors'
export interface TransportRequest { kind: TransportKind; query: string; tenantId: string; maxItems: number; signal: AbortSignal }
// upstream_requests: how many upstream requests this call made. The contract is exactly one; anything else is a violation.
export type TransportResult = { status: 'ok'; items: { url: string; title: string; quote: string; date: string | null }[]; upstream_requests?: number } | { status: 'throttled' | 'challenge' | 'unauthorized' | 'error' }
// session: true marks the signed-in session transport (post -> commenters/reactors plan, daily cap, pacing). Absent = a third-party transport (people/engagers plan).
export interface LinkedInTransport { fetch(req: TransportRequest): Promise<TransportResult>; session?: boolean }
export const DAY_CONNECTOR = 'adv:linkedin:day'
const intEnv = (v: string | undefined, d: number, max: number) => { const n = Number(v); return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : d }
export const sessionLimits = (env: Record<string, string | undefined>) => ({
  daily: intEnv(env.LINKEDIN_ENGAGERS_DAILY_CAP, 6, 50), perRun: intEnv(env.LINKEDIN_SESSION_PER_RUN, 3, MAX_REQUESTS_PER_HOUR), gapMs: intEnv(env.LINKEDIN_SESSION_GAP_MS, 20_000, 600_000),
})
const POST_URL = /^https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:activity:\d{10,25}\/?$/

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

export async function collectLinkedInPeople(db: Db, tenantId: string, jobId: string, icp: { who: string[]; where: string[]; industries: string[] }, deps: { transport?: LinkedInTransport; env?: Record<string, string | undefined>; now?: number; deadlineMs?: number; sleep?: (ms: number) => Promise<void>; onStop?: (status: string) => void; beforeRequest?: () => void | Promise<void> } = {}): Promise<LinkedInItem[]> {
  const envNow = () => deps.env ?? process.env, now = deps.now ?? Math.floor(Date.now() / 1000), deadlineMs = deps.deadlineMs ?? DEADLINE_MS
  const skip = async (status: string) => { await writeAudit(db, { tenantId, connector: PEOPLE_CONNECTOR, jobId, lookup: 'linkedin people', status, results: 0 }); return [] as LinkedInItem[] }
  const g0 = await gateStatus(db, tenantId, envNow()); if (g0) return skip(g0)
  if (!deps.transport) return skip('unavailable')                // no authorised transport: nothing is requested, and this is not "zero people"
  if (await coolingDown(db, tenantId, now)) return skip('cooldown')
  const session = deps.transport.session === true, lim = sessionLimits(envNow())
  const competitors = await readCompetitors(db, tenantId)
  // The session plan reads competitor posts and their engagers only (no people search); the third-party plan is unchanged.
  const queue: { kind: TransportKind; query: string }[] = session ? competitors.map(c => ({ kind: 'posts' as const, query: c.slice(0, 200) })) : linkedinQueries(icp, competitors, MAX_REQUESTS_PER_RUN)
  const perRun = session ? lim.perRun : MAX_REQUESTS_PER_RUN
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const out: LinkedInItem[] = [], seen = new Set<string>(); let made = 0
  const stop = async (lookup: string, status: string) => { await writeAudit(db, { tenantId, connector: ID, jobId, lookup, status, results: 0 }); deps.onStop?.(status) }
  while (queue.length > 0 && made < perRun) {
    const q = queue.shift()!
    if (session && made > 0) await sleep(lim.gapMs + Math.floor(Math.random() * lim.gapMs * 0.5))   // a human pace between session requests
    // Every gate again, immediately before THIS request: a switch flipped mid-run stops the run.
    const g = await gateStatus(db, tenantId, envNow()); if (g) { await skip(g); break }
    // The scan still owns this run (not cancelled, reaped or timed out): checked before the reservation, so a stopped scan neither spends budget nor calls LinkedIn.
    if (deps.beforeRequest) { try { await deps.beforeRequest() } catch (e) { try { await skip('scan_stopped') } catch { /* the audit write failed: the runner still sees the stop */ } throw e } }
    if (!(await reserveRequest(db, tenantId, ID, MAX_REQUESTS_PER_HOUR, 'people', now))) { if (made === 0) await skip('rate_limited'); else await skip('rate_limited_mid_run'); break }
    // The daily cap is reserved AFTER the hourly one: a refused day slot burns the hour slot (never undercounts), and the run stops visibly.
    if (session && !(await reserveRequest(db, tenantId, DAY_CONNECTOR, lim.daily, 'people', now, 86_400))) { await skip('daily_cap'); deps.onStop?.('daily_cap'); break }
    made++
    const lookup = `${q.kind}:${q.query}`
    const ctl = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined
    // Hard deadline: raced, so a transport that ignores the abort cannot hold the run or have a late answer accepted.
    const res = await Promise.race([
      deps.transport.fetch({ kind: q.kind, query: q.query, tenantId, maxItems: MAX_ITEMS, signal: ctl.signal }).catch((): TransportResult => ({ status: 'error' })),
      new Promise<'deadline'>(r => { timer = setTimeout(() => { ctl.abort(); r('deadline') }, deadlineMs) }),
    ]).finally(() => clearTimeout(timer))
    // A transport that missed the deadline is out of contract and may still be making unbudgeted upstream requests in the background: STOP the run, never feed it another reservation.
    if (res === 'deadline') { await stop(lookup, 'stopped_deadline'); break }   // the late result, if any, is dropped
    if (res.status !== 'ok') {
      if (res.status === 'error') { await writeAudit(db, { tenantId, connector: ID, jobId, lookup, status: 'error', results: 0 }); continue }
      await stop(lookup, `stopped_${res.status}`)     // throttled / challenge / unauthorised: visible, cooled down, never retried
      break
    }
    if ((res.upstream_requests ?? 1) !== 1) { await stop(lookup, 'stopped_contract'); break }
    if (q.kind === 'posts') {
      // A post search yields no leads: the first competitor post found is the one whose commenters and reactors are read next.
      const post = res.items.map(i => i.url).find(u => POST_URL.test(u))
      if (post) queue.unshift({ kind: 'commenters', query: post }, { kind: 'reactors', query: post })
      await writeAudit(db, { tenantId, connector: ID, jobId, lookup, status: post ? 'ok' : 'empty', results: post ? 1 : 0 })
      continue
    }   // more than one upstream request per call: contract broken
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
