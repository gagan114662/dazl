import type Database from 'better-sqlite3'
import { asDb, type DbLike, type Tx, type TxBody } from '../db/client.ts'
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
//
// On the Db layer (SQLite or Postgres): every function takes the store and keeps to the caller's tenant.

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
      checked_at INTEGER NOT NULL,
      domain     TEXT
    );
    CREATE INDEX IF NOT EXISTS seo_index_results_tenant ON seo_index_results (tenant_id, keyword, checked_at);
    CREATE TABLE IF NOT EXISTS seo_index_runs (
      tenant_id TEXT NOT NULL,
      ran_at    INTEGER NOT NULL,
      searches  INTEGER NOT NULL
    );
  `)
  // #904: every result names the domain it was checked against. Older rows (domain NULL) predate the binding and
  // are never shown as current for any domain - the keyword reads as not checked until a new run records it.
  const cols = db.prepare('PRAGMA table_info(seo_index_results)').all() as { name: string }[]
  if (!cols.some(c => c.name === 'domain')) db.exec('ALTER TABLE seo_index_results ADD COLUMN domain TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS seo_index_results_domain ON seo_index_results (tenant_id, domain, keyword, checked_at)')
}

export async function saveDomain(db: DbLike, tenantId: string, rawDomain: string): Promise<string | null> {
  const domain = normalizeDomain(rawDomain)?.replace(/^www\./, '') ?? null
  if (!domain) return null
  // A changed domain is due for a check now (its results start empty); saving the same domain keeps the schedule.
  // The weekly allowance (seo_index_runs) is never touched here, so editing the domain cannot reset spend.
  await asDb(db).run(`INSERT INTO seo_index_configs (tenant_id, domain, next_run_at) VALUES (?, ?, NULL)
    ON CONFLICT (tenant_id) DO UPDATE SET domain = excluded.domain,
      next_run_at = CASE WHEN seo_index_configs.domain = excluded.domain THEN seo_index_configs.next_run_at ELSE NULL END`, [tenantId, domain])
  return domain
}

export async function getConfig(db: DbLike, tenantId: string): Promise<{ domain: string; next_run_at: number | null } | null> {
  return (await asDb(db).get<{ domain: string; next_run_at: number | null }>('SELECT domain, next_run_at FROM seo_index_configs WHERE tenant_id = ?', [tenantId])) ?? null
}

export async function listKeywords(db: DbLike, tenantId: string): Promise<string[]> {
  return (await asDb(db).all<{ keyword: string }>('SELECT keyword FROM seo_index_keywords WHERE tenant_id = ? ORDER BY created_at ASC, keyword ASC', [tenantId])).map(r => r.keyword)
}

// The count and the insert in one transaction; on Postgres a per-tenant lock held to commit, so two instances adding at
// once cannot pass the cap together (SQLite runs one write transaction at a time).
export async function addKeyword(db: DbLike, tenantId: string, raw: string): Promise<{ ok: true } | { error: 'limit' | 'invalid' }> {
  const keyword = raw.trim().replace(/\s+/g, ' ').slice(0, 120)
  if (keyword.length < 2) return { error: 'invalid' }
  return asDb(db).tx(function* (t: Tx): TxBody<{ ok: true } | { error: 'limit' }> {
    if (t.kind === 'pg') yield* t.get("SELECT pg_advisory_xact_lock(hashtextextended('seo_index_keywords:' || ?, 0)) AS x", [tenantId])
    const n = Number((yield* t.get<{ n: number }>('SELECT count(*) AS n FROM seo_index_keywords WHERE tenant_id = ?', [tenantId]))!.n)
    if (n >= MAX_KEYWORDS) return { error: 'limit' }
    yield* t.run('INSERT INTO seo_index_keywords (tenant_id, keyword) VALUES (?, ?) ON CONFLICT (tenant_id, keyword) DO NOTHING', [tenantId, keyword])
    return { ok: true }
  })
}

export async function removeKeyword(db: DbLike, tenantId: string, keyword: string): Promise<void> {
  await asDb(db).run('DELETE FROM seo_index_keywords WHERE tenant_id = ? AND keyword = ?', [tenantId, keyword])
}

// Searches spent in the last 7 days - the weekly allowance, independent of any scan budget.
export async function weeklySpend(db: DbLike, tenantId: string, now: number): Promise<number> {
  return Number((await asDb(db).get<{ n: number }>('SELECT COALESCE(SUM(searches), 0) AS n FROM seo_index_runs WHERE tenant_id = ? AND ran_at >= ?', [tenantId, now - WEEK_S]))!.n)
}

const hostMatches = (url: string, domain: string): boolean => {
  const m = /^https:\/\/([^/?\s]+)/.exec(url)
  if (!m) return false
  const host = m[1].toLowerCase()
  return host === domain || host === `www.${domain}` || host.endsWith(`.${domain}`)
}

export type IndexCheck = { keyword: string; indexed: boolean; top_url: string | null }
export type IndexResult = IndexCheck & { domain: string; checked_at: number }

// Runs one batch: every saved keyword once, bounded by the remaining weekly allowance.
// Returns null when there is nothing to do (no config/keywords) or the allowance is spent, and 'stale_domain' when the
// domain was edited while the searches were in flight (results discarded, searches stay spent). [] is reserved for a
// provider failure so callers can tell an outage from a concurrent edit.
export async function runIndexChecks(db: DbLike, tenantId: string, deps: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; now?: number; id?: string } = {}): Promise<IndexCheck[] | 'stale_domain' | null> {
  const now = deps.now ?? Math.floor(Date.now() / 1000)
  const env = deps.env ?? process.env
  const cfg = await getConfig(db, tenantId)
  if (!cfg || !tinyfishEnabled(env)) return null
  const keywords = await listKeywords(db, tenantId)
  if (keywords.length === 0) return null
  // Claim this batch's searches from the weekly allowance BEFORE any request, in one short transaction (on Postgres a
  // per-tenant lock held to commit; SQLite runs one write transaction at a time): two runs at once - a manual run
  // and the tick, or two manual runs - cannot both spend the same allowance. No transaction stays open across a
  // network wait. The claim is a seo_index_runs row for the whole batch; once the batch ends, the searches it did
  // not send are given back as a negative row. A search that was sent counts even if it failed, and a run that
  // crashes keeps its whole claim spent.
  const claimed = await asDb(db).tx(function* (t: Tx): TxBody<number> {
    if (t.kind === 'pg') yield* t.get("SELECT pg_advisory_xact_lock(hashtextextended('seo_index_runs:' || ?, 0)) AS x", [tenantId])
    const used = Number((yield* t.get<{ n: number }>('SELECT COALESCE(SUM(searches), 0) AS n FROM seo_index_runs WHERE tenant_id = ? AND ran_at >= ?', [tenantId, now - WEEK_S]))!.n)
    const n = Math.min(keywords.length, WEEKLY_ALLOWANCE - used)
    if (n > 0) yield* t.run('INSERT INTO seo_index_runs (tenant_id, ran_at, searches) VALUES (?, ?, ?)', [tenantId, now, n])
    return n
  })
  if (claimed <= 0) return null
  // The tenant-approved allowance for this feature is 10/user/week - raise only the per-batch
  // cap (default 4/scan); tenant-daily and global caps are untouched.
  const batchEnv = { ...env, TINYFISH_SEARCHES_PER_SCAN: String(WEEKLY_ALLOWANCE) }
  const spent = { searches: 0 } // searches actually sent (tfSearch counts one before each request, failed or not)
  const out: IndexCheck[] = []
  try {
    for (const keyword of keywords.slice(0, claimed)) {
      const r = await tfSearch(db, tenantId, `site:${cfg.domain} ${keyword}`.slice(0, 300), {}, spent, { env: batchEnv, fetchImpl: deps.fetchImpl, now })
      if (!r.ok) break // cap/rate/auth/quota: stop the batch, keep what we have
      const own = r.hits.find(h => hostMatches(h.url, cfg.domain))
      out.push({ keyword, indexed: !!own, top_url: own?.url ?? null })
    }
  } finally {
    // give back what was claimed but never sent (a throw included); what was sent stays spent
    const unsent = claimed - spent.searches
    if (unsent > 0) await asDb(db).run('INSERT INTO seo_index_runs (tenant_id, ran_at, searches) VALUES (?, ?, ?)', [tenantId, now, -unsent])
  }
  if (out.length > 0) {
    const stamp = deps.id ?? `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`
    // #904 fence: the results and the next run commit only if the saved domain is still the one searched. A domain
    // edit during the awaited searches discards them (the searches stay spent above) and leaves the new domain due.
    // On Postgres the config row is locked to commit so a concurrent saveDomain orders strictly before or after.
    const committed = await asDb(db).tx(function* (t: Tx): TxBody<boolean> {
      const cur = yield* t.get<{ domain: string }>(`SELECT domain FROM seo_index_configs WHERE tenant_id = ?${t.kind === 'pg' ? ' FOR UPDATE' : ''}`, [tenantId])
      if (!cur || cur.domain !== cfg.domain) return false
      for (const [i, c] of out.entries()) {
        yield* t.run('INSERT INTO seo_index_results (id, tenant_id, keyword, indexed, top_url, checked_at, domain) VALUES (?, ?, ?, ?, ?, ?, ?)', [`${stamp}${i}`, tenantId, c.keyword, c.indexed ? 1 : 0, c.top_url, now, cfg.domain])
      }
      yield* t.run('UPDATE seo_index_configs SET next_run_at = ? WHERE tenant_id = ? AND domain = ?', [now + WEEK_S, tenantId, cfg.domain])
      return true
    })
    if (!committed) return 'stale_domain'
  }
  return out
}

// Latest result per keyword for the tenant's CURRENTLY saved domain (#904): results recorded for an earlier domain,
// or before results named their domain, are not current. Exactly one row per keyword: ties on checked_at are broken
// by id (descending), the same on both engines.
export async function latestResults(db: DbLike, tenantId: string): Promise<IndexResult[]> {
  return (await asDb(db).all<{ keyword: string; indexed: number; top_url: string | null; domain: string; checked_at: number }>(`
    SELECT keyword, indexed, top_url, domain, checked_at FROM (
      SELECT r.keyword, r.indexed, r.top_url, r.domain, r.checked_at,
        ROW_NUMBER() OVER (PARTITION BY r.keyword ORDER BY r.checked_at DESC, r.id DESC) AS rn
      FROM seo_index_results r JOIN seo_index_configs c ON c.tenant_id = r.tenant_id AND c.domain = r.domain
      WHERE r.tenant_id = ?) x
    WHERE rn = 1 ORDER BY keyword ASC`, [tenantId]))
    .map(r => ({ keyword: r.keyword, indexed: !!r.indexed, top_url: r.top_url, domain: r.domain, checked_at: Number(r.checked_at) }))
}

// Tenants whose weekly check is due (never run, or next_run_at in the past).
export async function dueTenants(db: DbLike, now: number): Promise<string[]> {
  return (await asDb(db).all<{ tenant_id: string }>('SELECT tenant_id FROM seo_index_configs WHERE next_run_at IS NULL OR next_run_at <= ? ORDER BY tenant_id', [now])).map(r => r.tenant_id)
}
