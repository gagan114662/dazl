// Competitor complaints on Reddit: a public post complaining about a competitor is
// prospecting evidence (the user picked this shape: post as candidate, complaint as
// the quote, badge naming the competitor). Search goes through the existing Reddit
// worker fetcher - same consent scope, same per-tenant session with operator-env
// fallback, same rate budget as the other advanced fetchers. Public posts only,
// nothing is ever sent anywhere. Competitors are configured in Settings (max 5).
import type Database from 'better-sqlite3'
import type { Db, Tx, TxBody } from '../db/client.ts'
import type { Evidence } from '../sources/types.ts'
import { audit, getEnabledCredential } from '../connectors/store.ts'
import { advFlags, connectorId, maxCallsPerHour, platformAllowed, scopeFor } from '../advanced/config.ts'
import { hasConsent, httpWorker, type WorkerFetch } from '../advanced/index.ts'

export const MAX_COMPETITORS = 5
const MAX_POST_AGE_DAYS = 30
export const COMPLAINT_CONNECTOR = 'adv:reddit-competitor'

export function migrateCompetitors(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS tenant_competitors (
    tenant_id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, name)
  );`)
}

export function cleanCompetitorName(v: unknown): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
}

const COMPETITORS_SQL = 'SELECT name FROM tenant_competitors WHERE tenant_id = ? ORDER BY position'
// Sync for the complaint collector (scan runner, raw handle); readCompetitors for the settings route (Db layer).
export function listCompetitors(db: Database.Database, tenantId: string): string[] {
  return (db.prepare(COMPETITORS_SQL).all(tenantId) as { name: string }[]).map(r => r.name)
}
export async function readCompetitors(db: Db, tenantId: string): Promise<string[]> {
  return (await db.all<{ name: string }>(COMPETITORS_SQL, [tenantId])).map(r => r.name)
}

// On the Db layer: the list is replaced in one transaction.
export async function setCompetitors(db: Db, tenantId: string, names: string[]): Promise<{ ok: boolean; error?: string; names: string[] }> {
  const cleaned = [...new Set(names.map(cleanCompetitorName).filter(Boolean))]
  if (cleaned.length > MAX_COMPETITORS) return { ok: false, error: `Up to ${MAX_COMPETITORS} competitors`, names: [] }
  for (const n of cleaned) if (n.length < 2) return { ok: false, error: 'Competitor names need at least 2 characters', names: [] }
  await db.tx(function* (t: Tx): TxBody<void> {
    yield* t.run('DELETE FROM tenant_competitors WHERE tenant_id = ?', [tenantId])
    for (const [i, n] of cleaned.entries()) yield* t.run('INSERT INTO tenant_competitors (tenant_id, name, position) VALUES (?, ?, ?)', [tenantId, n, i])
  })
  return { ok: true, names: cleaned }
}

export const complaintQuery = (name: string): string => `${name} (complaint OR alternative OR hate OR cancel)`

// Connector audit rows share the per-platform hourly budget with the normal Reddit
// fetcher: complaint searches count as adv:reddit calls so the two never stack.
function redditCallsLastHour(db: Database.Database, tenantId: string): number {
  const r = db.prepare("SELECT COUNT(*) AS n FROM connector_audit WHERE tenant_id = ? AND connector IN ('adv:reddit', 'adv:reddit-competitor') AND created_at > CAST(strftime('%s','now') AS INTEGER) - 3600").get(tenantId) as { n: number }
  return r.n
}

export interface ComplaintItem extends Evidence { login_walled: boolean; complaint_of: string }

// One worker search per configured competitor. Never throws into the runner.
export async function collectCompetitorComplaints(db: Database.Database, tenantId: string, jobId: string, deps: { worker?: WorkerFetch; master?: Buffer; env?: Record<string, string | undefined> } = {}): Promise<ComplaintItem[]> {
  const env = deps.env ?? process.env
  const competitors = listCompetitors(db, tenantId).slice(0, MAX_COMPETITORS)
  if (competitors.length === 0) return []
  const skip = (status: string) => audit(db, { tenantId, connector: COMPLAINT_CONNECTOR, jobId, lookup: `${competitors.length} competitors`, status, results: 0 })
  if (!platformAllowed('reddit', advFlags(env))) { skip('disabled'); return [] }
  if (!hasConsent(db, tenantId, scopeFor('reddit'))) { skip('no_consent'); return [] }
  const budget = maxCallsPerHour('reddit', env) - redditCallsLastHour(db, tenantId)
  if (budget <= 0) { skip('rate_limited'); return [] }
  const worker = deps.worker ?? httpWorker(env)
  const session = getEnabledCredential(db, tenantId, connectorId('reddit'), deps.master) || ''
  const cutoff = Date.now() - MAX_POST_AGE_DAYS * 86400_000
  const out: ComplaintItem[] = []
  for (const name of competitors.slice(0, budget)) {
    const q = complaintQuery(name)
    const items = await worker({ platform: 'reddit', query: q.slice(0, 300), session }).catch(() => null)
    if (items === null) { audit(db, { tenantId, connector: COMPLAINT_CONNECTOR, jobId, lookup: q, status: 'worker_error', results: 0 }); continue }
    const fresh = items.filter(i => i.date && new Date(i.date).getTime() >= cutoff)
    audit(db, { tenantId, connector: COMPLAINT_CONNECTOR, jobId, lookup: q, status: fresh.length ? 'ok' : 'empty', results: fresh.length })
    for (const it of fresh.slice(0, 10)) out.push({ source: COMPLAINT_CONNECTOR, url: it.url, title: it.title, quote: it.quote, date: it.date, login_walled: it.login_walled, complaint_of: name })
  }
  return out
}

// After leads are written: any lead citing a complaint post gets the
// "complained about <competitor>" badge merged into its signals (never overwritten).
export function badgeComplaintLeads(db: Database.Database, jobId: string, complaints: { url: string; complaint_of: string }[]): number {
  let n = 0
  const find = db.prepare('SELECT id, signals FROM leads WHERE scan_job_id = ? AND source_url = ?')
  const upd = db.prepare('UPDATE leads SET signals = ? WHERE id = ?')
  for (const c of complaints) {
    const tag = `complained about ${c.complaint_of}`
    for (const r of find.all(jobId, c.url) as { id: string; signals: string | null }[]) {
      let sig: string[] = []
      try { const p = JSON.parse(r.signals || '[]'); if (Array.isArray(p)) sig = p.filter(x => typeof x === 'string') } catch { sig = [] }
      if (sig.includes(tag)) continue
      sig.push(tag)
      upd.run(JSON.stringify(sig), r.id)
      n++
    }
  }
  return n
}
