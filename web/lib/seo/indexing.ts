import type Database from 'better-sqlite3'
import { tfSearch, tinyfishEnabled } from '../search/tinyfish.ts'
import { normalizeDomain } from './audit.ts'

// Weekly indexing checks: does a search engine list the tenant's domain for their keywords?
// For each saved keyword we run one TinyFish search "site:<domain> <keyword>" and record whether
// any result belongs to the domain. Answers are INDICATIVE - search indexes vary by time, place
// and personalization; a "not found" is a prompt to look, not proof of a problem.
//
// Budget: the tenant approved 10 TinyFish searches per user per week for this feature, separate
// from the 4-per-scan cap. We enforce that with seo_index_runs (rolling 7 days) and pass the
// raised per-batch cap into tfSearch; the per-tenant daily and global TinyFish caps still apply.

export const MAX_KEYWORDS = 10
export const WEEKLY_ALLOWANCE = 10
const WEEK_S = 7 * 24 * 60 * 60

export function migrateIndexing(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS seo_index_configs (
      tenant_id   TEXT PRIMARY KEY,
      domain      TEXT NOT NULL,
      next_run_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS seo_index_keywords (
      tenant_id  TEXT NOT NULL,
      keyword    TEXT NOT NULL CHECK (length(keyword) BETWEEN 1 AND 120),
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      PRIMARY KEY (tenant_id, keyword)
    );
    CREATE TABLE IF NOT EXISTS seo_index_results (
      id         TEXT PRIMARY KEY,
      tenant_id  TEXT NOT NULL,
      keyword    TEXT NOT NULL,
      indexed    INTEGER NOT NULL,
      top_url    TEXT,
      checked_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS seo_index_results_tenant ON seo_index_results (tenant_id, keyword, checked_at);
    CREATE TABLE IF NOT EXISTS seo_index_runs (
      tenant_id TEXT NOT NULL,
      ran_at    INTEGER NOT NULL,
      searches  INTEGER NOT NULL
    );
  `)
}

export function saveDomain(db: Database.Database, tenantId: string, rawDomain: string): string | null {
  const domain = normalizeDomain(rawDomain)?.replace(/^www\./, '') ?? null
  if (!domain) return null
  db.prepare('INSERT INTO seo_index_configs (tenant_id, domain, next_run_at) VALUES (?, ?, NULL) ON CONFLICT(tenant_id) DO UPDATE SET domain = excluded.domain').run(tenantId, domain)
  return domain
}

export function getConfig(db: Database.Database, tenantId: string): { domain: string; next_run_at: number | null } | null {
  return (db.prepare('SELECT domain, next_run_at FROM seo_index_configs WHERE tenant_id = ?').get(tenantId) as { domain: string; next_run_at: number | null } | undefined) ?? null
}

export function listKeywords(db: Database.Database, tenantId: string): string[] {
  return (db.prepare('SELECT keyword FROM seo_index_keywords WHERE tenant_id = ? ORDER BY created_at ASC').all(tenantId) as { keyword: string }[]).map(r => r.keyword)
}

export function addKeyword(db: Database.Database, tenantId: string, raw: string): { ok: true } | { error: 'limit' | 'invalid' } {
  const keyword = raw.trim().replace(/\s+/g, ' ').slice(0, 120)
  if (keyword.length < 2) return { error: 'invalid' }
  const n = (db.prepare('SELECT count(*) AS n FROM seo_index_keywords WHERE tenant_id = ?').get(tenantId) as { n: number }).n
  if (n >= MAX_KEYWORDS) return { error: 'limit' }
  db.prepare('INSERT OR IGNORE INTO seo_index_keywords (tenant_id, keyword) VALUES (?, ?)').run(tenantId, keyword)
  return { ok: true }
}

export function removeKeyword(db: Database.Database, tenantId: string, keyword: string): void {
  db.prepare('DELETE FROM seo_index_keywords WHERE tenant_id = ? AND keyword = ?').run(tenantId, keyword)
}

// Searches spent in the last 7 days - the weekly allowance, independent of any scan budget.
export function weeklySpend(db: Database.Database, tenantId: string, now: number): number {
  return (db.prepare('SELECT COALESCE(SUM(searches),0) AS n FROM seo_index_runs WHERE tenant_id = ? AND ran_at >= ?').get(tenantId, now - WEEK_S) as { n: number }).n
}

const hostMatches = (url: string, domain: string): boolean => {
  const m = /^https:\/\/([^/?\s]+)/.exec(url)
  if (!m) return false
  const host = m[1].toLowerCase()
  return host === domain || host === `www.${domain}` || host.endsWith(`.${domain}`)
}

export type IndexCheck = { keyword: string; indexed: boolean; top_url: string | null }

// Runs one batch: every saved keyword once, bounded by the remaining weekly allowance.
// Returns null when there is nothing to do (no config/keywords) or the allowance is spent.
export async function runIndexChecks(db: Database.Database, tenantId: string, deps: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; now?: number; id?: string } = {}): Promise<IndexCheck[] | null> {
  const now = deps.now ?? Math.floor(Date.now() / 1000)
  const env = deps.env ?? process.env
  const cfg = getConfig(db, tenantId)
  if (!cfg || !tinyfishEnabled(env)) return null
  const keywords = listKeywords(db, tenantId)
  if (keywords.length === 0) return null
  const remaining = WEEKLY_ALLOWANCE - weeklySpend(db, tenantId, now)
  if (remaining <= 0) return null
  // The tenant-approved allowance for this feature is 10/user/week - raise only the per-batch
  // cap (default 4/scan); tenant-daily and global caps are untouched.
  const batchEnv = { ...env, TINYFISH_SEARCHES_PER_SCAN: String(WEEKLY_ALLOWANCE) }
  const spent = { searches: 0 }
  const out: IndexCheck[] = []
  for (const keyword of keywords.slice(0, remaining)) {
    const r = await tfSearch(db, tenantId, `site:${cfg.domain} ${keyword}`.slice(0, 300), {}, spent, { env: batchEnv, fetchImpl: deps.fetchImpl, now })
    if (!r.ok) break // cap/rate/auth/quota: stop the batch, keep what we have
    const own = r.hits.find(h => hostMatches(h.url, cfg.domain))
    out.push({ keyword, indexed: !!own, top_url: own?.url ?? null })
  }
  if (out.length > 0) {
    const stamp = deps.id ?? `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`
    for (const [i, c] of out.entries()) {
      db.prepare('INSERT INTO seo_index_results (id, tenant_id, keyword, indexed, top_url, checked_at) VALUES (?, ?, ?, ?, ?, ?)').run(`${stamp}${i}`, tenantId, c.keyword, c.indexed ? 1 : 0, c.top_url, now)
    }
    db.prepare('INSERT INTO seo_index_runs (tenant_id, ran_at, searches) VALUES (?, ?, ?)').run(tenantId, now, spent.searches)
    db.prepare('UPDATE seo_index_configs SET next_run_at = ? WHERE tenant_id = ?').run(now + WEEK_S, tenantId)
  }
  return out
}

// Latest result per keyword for the tenant.
export function latestResults(db: Database.Database, tenantId: string): IndexCheck[] {
  return (db.prepare(`
    SELECT r.keyword, r.indexed, r.top_url FROM seo_index_results r
    JOIN (SELECT keyword, MAX(checked_at) AS mx FROM seo_index_results WHERE tenant_id = ? GROUP BY keyword) latest
      ON latest.keyword = r.keyword AND latest.mx = r.checked_at
    WHERE r.tenant_id = ? ORDER BY r.keyword ASC`).all(tenantId, tenantId) as { keyword: string; indexed: number; top_url: string | null }[])
    .map(r => ({ keyword: r.keyword, indexed: !!r.indexed, top_url: r.top_url }))
}

// Tenants whose weekly check is due (never run, or next_run_at in the past).
export function dueTenants(db: Database.Database, now: number): string[] {
  return (db.prepare('SELECT tenant_id FROM seo_index_configs WHERE next_run_at IS NULL OR next_run_at <= ?').all(now) as { tenant_id: string }[]).map(r => r.tenant_id)
}
