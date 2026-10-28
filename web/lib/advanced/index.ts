import type Database from 'better-sqlite3'
import type { Db } from '../db/client.ts'
import { audit, getEnabledCredential } from '../connectors/store.ts'
import type { Evidence } from '../sources/types.ts'
import { advFlags, CONSENT_VERSION, connectorId, maxCallsPerHour, platformAllowed, scopeFor, type AdvPlatform, type ConsentScope } from './config.ts'
import { tfSearch, tinyfishEnabled } from '../search/tinyfish.ts'

export function migrateAdvanced(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS advanced_consent (
    tenant_id TEXT NOT NULL, scope TEXT NOT NULL, version TEXT NOT NULL,
    accepted_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
    PRIMARY KEY (tenant_id, scope)
  );`)
}

// Each consent read and write exists sync (the raw handle: the scan pipeline and its fixtures) and async on Db (the
// settings route), with one SQL string each. The acceptance time comes from the caller's clock (epoch seconds).
const ACCEPT_SQL = 'INSERT INTO advanced_consent (tenant_id, scope, version, accepted_at) VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id, scope) DO UPDATE SET version = excluded.version, accepted_at = excluded.accepted_at'
const REVOKE_SQL = 'DELETE FROM advanced_consent WHERE tenant_id = ? AND scope = ?'
const CONSENT_SQL = 'SELECT version FROM advanced_consent WHERE tenant_id = ? AND scope = ?'
const nowS = () => Math.floor(Date.now() / 1000)
export function acceptConsent(db: Database.Database, tenantId: string, scope: ConsentScope): void {
  db.prepare(ACCEPT_SQL).run(tenantId, scope, CONSENT_VERSION, nowS())
}
export async function writeConsent(db: Db, tenantId: string, scope: ConsentScope): Promise<void> {
  await db.run(ACCEPT_SQL, [tenantId, scope, CONSENT_VERSION, nowS()])
}
export function revokeConsent(db: Database.Database, tenantId: string, scope: ConsentScope): void {
  db.prepare(REVOKE_SQL).run(tenantId, scope)
}
export async function removeConsent(db: Db, tenantId: string, scope: ConsentScope): Promise<void> {
  await db.run(REVOKE_SQL, [tenantId, scope])
}
// Consent only counts for the current wording; a new version asks again.
export function hasConsent(db: Database.Database, tenantId: string, scope: ConsentScope): boolean {
  return (db.prepare(CONSENT_SQL).get(tenantId, scope) as { version: string } | undefined)?.version === CONSENT_VERSION
}
export async function readConsent(db: Db, tenantId: string, scope: ConsentScope): Promise<boolean> {
  return (await db.get<{ version: string }>(CONSENT_SQL, [tenantId, scope]))?.version === CONSENT_VERSION
}

export interface WorkerItem { url: string; title: string; quote: string; date: string | null; login_walled: boolean }
export type WorkerFetch = (req: { platform: AdvPlatform; query: string; session: string }) => Promise<WorkerItem[] | null>

// Worker protocol: POST {platform, query, session} with a bearer token, reply {items:[{url,title,quote,date,login_walled}]}.
// The request carries one tenant's own session and nothing else: no tenant id, no DB access, no other keys.
export function httpWorker(env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): WorkerFetch {
  return async req => {
    try {
      const res = await fetchImpl(`${env.ADVANCED_WORKER_URL!.replace(/\/$/, '')}/fetch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.ADVANCED_WORKER_TOKEN}` },
        body: JSON.stringify(req),
        redirect: 'error',
        signal: AbortSignal.timeout(45_000),
      })
      if (!res.ok) return null
      const text = await res.text()
      if (text.length > 1_000_000) return null
      return parseWorkerItems(JSON.parse(text))
    } catch { return null }
  }
}

export function parseWorkerItems(raw: unknown): WorkerItem[] {
  const arr = (raw as { items?: unknown })?.items
  if (!Array.isArray(arr)) return []
  const out: WorkerItem[] = []
  for (const it of arr.slice(0, 20)) {
    const o = it as Record<string, unknown>
    if (typeof o?.url !== 'string' || !/^https:\/\/[^\s]{4,480}$/.test(o.url)) continue
    if (typeof o.title !== 'string' || typeof o.quote !== 'string' || o.quote.length < 20) continue
    const date = typeof o.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? o.date : null
    out.push({ url: o.url, title: o.title.slice(0, 200), quote: o.quote.slice(0, 300), date, login_walled: o.login_walled === true })
  }
  return out
}

function callsLastHour(db: Database.Database, tenantId: string, platform: AdvPlatform): number {
  return (db.prepare("SELECT count(*) AS n FROM connector_audit WHERE tenant_id = ? AND connector = ? AND status IN ('ok','empty','worker_error') AND created_at >= CAST(strftime('%s','now') AS INTEGER) - 3600").get(tenantId, connectorId(platform)) as { n: number }).n
}

// X search AND-matches every token, so a full natural-language scan sentence returns
// nothing. Build a short keyword query from the scan's ICP instead: intent words first
// (the buying signals), then buyer words. Reddit and the rest keep the raw query.
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'their', 'they', 'them', 'are', 'was', 'were', 'has', 'have', 'had', 'who', 'what', 'where', 'when', 'into', 'your', 'you', 'our', 'out', 'all', 'any', 'not', 'but', 'his', 'her', 'its', 'over', 'under', 'about', 'after', 'before', 'more', 'most', 'some', 'such', 'just', 'like', 'also', 'than', 'then', 'too', 'very', 'can', 'will', 'would', 'could', 'should', 'first', 'new'])
export function xSearchQuery(icp: { who: string[]; signals: string[] }): string {
  const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w))
  const seen = new Set<string>()
  const pick: string[] = []
  for (const w of [...icp.signals.map(words).flat().slice(0, 6), ...icp.who.map(words).flat().slice(0, 6)]) {
    if (!seen.has(w)) { seen.add(w); pick.push(w) }
    if (pick.length >= 5) break
  }
  return pick.slice(0, 5).join(' ').slice(0, 100)
}

// Runs the platforms this tenant chose for one scan. Every gate is re-checked here, so a stale
// request cannot get around a flag, a kill switch, a missing consent or the rate limit.
export async function collectAdvanced(db: Database.Database, tenantId: string, jobId: string, platforms: AdvPlatform[], query: string, deps: { worker?: WorkerFetch; master?: Buffer; env?: Record<string, string | undefined>; xQuery?: string; fetchImpl?: typeof fetch } = {}): Promise<(Evidence & { login_walled: boolean })[]> {
  const env = deps.env ?? process.env
  const flags = advFlags(env)
  const worker = deps.worker ?? httpWorker(env)
  const out: (Evidence & { login_walled: boolean })[] = []
  for (const p of platforms) {
    const id = connectorId(p)
    const q = p === 'x' && deps.xQuery ? deps.xQuery : query
    const skip = (status: string) => audit(db, { tenantId, connector: id, jobId, lookup: q, status, results: 0 })
    if (!platformAllowed(p, flags)) { skip('disabled'); continue }
    if (!hasConsent(db, tenantId, scopeFor(p))) { skip('no_consent'); continue }
    if (callsLastHour(db, tenantId, p) >= maxCallsPerHour(p, env)) { skip('rate_limited'); continue }
    // X path 1: operator-key web search of the public index (TinyFish free tier, capped
    // per scan / tenant / day). No account session is used, so nothing here can get a
    // tenant's account banned. A search snippet is not the verbatim post text, so every
    // hit is login_walled: the quote-verification gate keeps them in the review lane and
    // they are never auto-verified. Set X_VIA_SEARCH=0 to force the worker path.
    if (p === 'x' && env.X_VIA_SEARCH !== '0' && tinyfishEnabled(env)) {
      const r = await tfSearch(db, tenantId, `site:x.com ${q}`.slice(0, 300), {}, { searches: 0 }, { env, fetchImpl: deps.fetchImpl })
      if (!r.ok) { skip(r.reason); continue }
      const items: (Evidence & { login_walled: boolean })[] = []
      for (const h of r.hits.slice(0, 20)) {
        if (!/^https:\/\/(www\.)?(x|twitter)\.com\/[^\s]{4,460}$/.test(h.url)) continue
        const quote = (h.snippet.length >= 20 ? h.snippet : h.title).slice(0, 300)
        if (quote.length < 20) continue
        items.push({ source: id, url: h.url, title: h.title.slice(0, 200), quote, date: h.date, login_walled: true })
      }
      audit(db, { tenantId, connector: id, jobId, lookup: q, status: items.length ? 'ok' : 'empty', results: items.length })
      out.push(...items)
      continue
    }
    // X path 2 (worker): tenant's own session when stored; '' otherwise - the worker falls back to the
    // throwaway sessions in its env (X_SESSION_COOKIE / REDDIT_SESSION_COOKIE),
    // which the site owner placed there for the connector fetchers. A worker with
    // neither answers no_session, which audits as worker_error here.
    const session = getEnabledCredential(db, tenantId, id, deps.master) || ''
    const items = await worker({ platform: p, query: q.slice(0, 300), session })
    if (items === null) { skip('worker_error'); continue }
    audit(db, { tenantId, connector: id, jobId, lookup: q, status: items.length ? 'ok' : 'empty', results: items.length })
    for (const it of items) out.push({ source: id, url: it.url, title: it.title, quote: it.quote, date: it.date, login_walled: it.login_walled })
  }
  return out
}
