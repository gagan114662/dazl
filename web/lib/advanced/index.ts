import type Database from 'better-sqlite3'
import { asDb, type Db, type DbLike } from '../db/client.ts'
import { readEnabledCredential, writeAudit } from '../connectors/store.ts'
import type { Evidence } from '../sources/types.ts'
import { advFlags, CONSENT_VERSION, connectorId, maxCallsPerHour, platformAllowed, platformSupported, scopeFor, type AdvPlatform, type ConsentScope } from './config.ts'
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
// A worker answer: the items of a search that ran (possibly none), or why it did not run (#436). null: the worker itself
// could not be reached or answered something unreadable.
export type WorkerFailureCode = 'unsupported' | 'auth' | 'throttled' | 'schema' | 'upstream' | 'timeout' | 'error'
export type WorkerFailure = { failure: WorkerFailureCode }
export type WorkerFetch = (req: { platform: AdvPlatform; query: string; session: string }) => Promise<WorkerItem[] | WorkerFailure | null>
const FAILURES = new Set<string>(['unsupported', 'auth', 'throttled', 'schema', 'upstream', 'timeout', 'error'])
// The connector audit status for an answer that is not a list of items. A genuine empty search is 'empty' (callers);
// these are distinct so a search that never happened is never shown as one that found nothing.
export function workerAuditStatus(r: WorkerFailure | null): string {
  if (!r) return 'worker_error'
  return r.failure === 'unsupported' ? 'unsupported' : r.failure === 'auth' ? 'auth_failed' : r.failure === 'throttled' ? 'throttled' : r.failure === 'schema' ? 'schema_error' : 'worker_error'
}
// Statuses that mean the platform was actually called (they count toward the hourly limit).
export const CALLED_STATUSES = ['ok', 'empty', 'worker_error', 'auth_failed', 'throttled', 'schema_error'] as const

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
      if (res.status === 501) return { failure: 'unsupported' }
      if (!res.ok) return null
      const text = await res.text()
      if (text.length > 1_000_000) return null
      const json = JSON.parse(text) as { outcome?: unknown }
      if (typeof json?.outcome === 'string') return FAILURES.has(json.outcome) ? { failure: json.outcome as WorkerFailureCode } : null
      return parseWorkerItems(json)
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

async function callsLastHour(db: Db, tenantId: string, platform: AdvPlatform, now: number): Promise<number> {
  return Number((await db.get<{ n: number }>(`SELECT count(*) AS n FROM connector_audit WHERE tenant_id = ? AND connector = ? AND status IN (${CALLED_STATUSES.map(s => `'${s}'`).join(',')}) AND created_at >= ?`, [tenantId, connectorId(platform), now - 3600]))!.n)
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
// request cannot get around a flag, a kill switch, a missing consent or the rate limit. On the Db layer; today's runner
// passes its raw handle, which runs on that same connection (DbLike).
export async function collectAdvanced(store: DbLike, tenantId: string, jobId: string, platforms: AdvPlatform[], query: string, deps: { worker?: WorkerFetch; master?: Buffer; env?: Record<string, string | undefined>; xQuery?: string; fetchImpl?: typeof fetch; now?: number } = {}): Promise<(Evidence & { login_walled: boolean })[]> {
  const db = asDb(store)
  const env = deps.env ?? process.env
  const flags = advFlags(env)
  const worker = deps.worker ?? httpWorker(env)
  const out: (Evidence & { login_walled: boolean })[] = []
  for (const p of platforms) {
    const id = connectorId(p)
    const q = p === 'x' && deps.xQuery ? deps.xQuery : query
    const skip = (status: string) => writeAudit(db, { tenantId, connector: id, jobId, lookup: q, status, results: 0 })
    if (!platformAllowed(p, flags)) { await skip('disabled'); continue }
    // a platform the worker cannot read is not searched and no session is sent: recorded as unsupported, not empty
    if (!platformSupported(p)) { await skip('unsupported'); continue }
    if (!(await readConsent(db, tenantId, scopeFor(p)))) { await skip('no_consent'); continue }
    if (await callsLastHour(db, tenantId, p, deps.now ?? Math.floor(Date.now() / 1000)) >= maxCallsPerHour(p, env)) { await skip('rate_limited'); continue }
    // X path 1: operator-key web search of the public index (TinyFish free tier, capped
    // per scan / tenant / day). No account session is used, so nothing here can get a
    // tenant's account banned. A search snippet is not the verbatim post text, so every
    // hit is login_walled: the quote-verification gate keeps them in the review lane and
    // they are never auto-verified. Set X_VIA_SEARCH=0 to force the worker path.
    if (p === 'x' && env.X_VIA_SEARCH !== '0' && tinyfishEnabled(env)) {
      const r = await tfSearch(db, tenantId, `site:x.com ${q}`.slice(0, 300), {}, { searches: 0 }, { env, fetchImpl: deps.fetchImpl })
      if (!r.ok) { await skip(r.reason); continue }
      const items: (Evidence & { login_walled: boolean })[] = []
      for (const h of r.hits.slice(0, 20)) {
        if (!/^https:\/\/(www\.)?(x|twitter)\.com\/[^\s]{4,460}$/.test(h.url)) continue
        const quote = (h.snippet.length >= 20 ? h.snippet : h.title).slice(0, 300)
        if (quote.length < 20) continue
        items.push({ source: id, url: h.url, title: h.title.slice(0, 200), quote, date: h.date, login_walled: true })
      }
      await writeAudit(db, { tenantId, connector: id, jobId, lookup: q, status: items.length ? 'ok' : 'empty', results: items.length })
      out.push(...items)
      continue
    }
    // X path 2 (worker): tenant's own session when stored; '' otherwise - the worker falls back to the
    // throwaway sessions in its env (X_SESSION_COOKIE / REDDIT_SESSION_COOKIE),
    // which the site owner placed there for the connector fetchers. A worker with
    // neither answers no_session, which audits as worker_error here.
    const session = (await readEnabledCredential(db, tenantId, id, deps.master)) || ''
    const items = await worker({ platform: p, query: q.slice(0, 300), session })
    if (!Array.isArray(items)) { await skip(workerAuditStatus(items)); continue }
    await writeAudit(db, { tenantId, connector: id, jobId, lookup: q, status: items.length ? 'ok' : 'empty', results: items.length })
    for (const it of items) out.push({ source: id, url: it.url, title: it.title, quote: it.quote, date: it.date, login_walled: it.login_walled })
  }
  return out
}
