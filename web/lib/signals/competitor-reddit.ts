// Competitor complaints on Reddit: a public post complaining about a competitor is
// prospecting evidence (the user picked this shape: post as candidate, complaint as
// the quote, badge naming the competitor). Search goes through the existing Reddit
// worker fetcher - same consent scope, same per-tenant session with operator-env
// fallback, same rate budget as the other advanced fetchers. Public posts only,
// nothing is ever sent anywhere. Competitors are configured in Settings (max 5).
import type Database from 'better-sqlite3'
import type { Db, Tx, TxBody } from '../db/client.ts'
import type { Evidence } from '../sources/types.ts'
import { audit, getEnabledCredential, readEnabledCredential, writeAudit, type AuditEntry } from '../connectors/store.ts'
import { advFlags, connectorId, maxCallsPerHour, platformAllowed, scopeFor } from '../advanced/config.ts'
import { hasConsent, httpWorker, itemsOrNull, readConsent, type WorkerFetch } from '../advanced/index.ts'

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
const CALLS_LAST_HOUR_SQL = "SELECT COUNT(*) AS n FROM connector_audit WHERE tenant_id = ? AND connector IN ('adv:reddit', 'adv:reddit-competitor') AND created_at > ?"

export interface ComplaintItem extends Evidence { login_walled: boolean; complaint_of: string }
type ComplaintDeps = { worker?: WorkerFetch; master?: Buffer; env?: Record<string, string | undefined>; now?: number }

// The store reads and writes one complaint search needs; a sync raw handle or the Db layer behind the same steps.
interface ComplaintStore {
  competitors(): Promise<string[]>
  consented(): Promise<boolean>
  callsLastHour(since: number): Promise<number>
  session(): Promise<string | null>
  audit(a: AuditEntry): Promise<void>
}
async function complaints(store: ComplaintStore, tenantId: string, jobId: string, deps: ComplaintDeps): Promise<ComplaintItem[]> {
  const env = deps.env ?? process.env
  const competitors = (await store.competitors()).slice(0, MAX_COMPETITORS)
  if (competitors.length === 0) return []
  const skip = (status: string) => store.audit({ tenantId, connector: COMPLAINT_CONNECTOR, jobId, lookup: `${competitors.length} competitors`, status, results: 0 })
  if (!platformAllowed('reddit', advFlags(env))) { await skip('disabled'); return [] }
  if (!(await store.consented())) { await skip('no_consent'); return [] }
  const budget = maxCallsPerHour('reddit', env) - await store.callsLastHour((deps.now ?? Math.floor(Date.now() / 1000)) - 3600)
  if (budget <= 0) { await skip('rate_limited'); return [] }
  const worker = deps.worker ?? httpWorker(env)
  const session = (await store.session()) || ''
  const cutoff = Date.now() - MAX_POST_AGE_DAYS * 86400_000
  const out: ComplaintItem[] = []
  for (const name of competitors.slice(0, budget)) {
    const q = complaintQuery(name)
    const items = itemsOrNull(await worker({ platform: 'reddit', query: q.slice(0, 300), session }).catch(() => null))
    if (items === null) { await store.audit({ tenantId, connector: COMPLAINT_CONNECTOR, jobId, lookup: q, status: 'worker_error', results: 0 }); continue }
    const fresh = items.filter(i => i.date && new Date(i.date).getTime() >= cutoff)
    await store.audit({ tenantId, connector: COMPLAINT_CONNECTOR, jobId, lookup: q, status: fresh.length ? 'ok' : 'empty', results: fresh.length })
    for (const it of fresh.slice(0, 10)) out.push({ source: COMPLAINT_CONNECTOR, url: it.url, title: it.title, quote: it.quote, date: it.date, login_walled: it.login_walled, complaint_of: name })
  }
  return out
}

// One worker search per configured competitor. Never throws into the runner. Sync store on the raw handle (the runner
// today); gatherCompetitorComplaints is the same on the Db layer (the runner's storage port).
export function collectCompetitorComplaints(db: Database.Database, tenantId: string, jobId: string, deps: ComplaintDeps = {}): Promise<ComplaintItem[]> {
  return complaints({
    competitors: async () => listCompetitors(db, tenantId),
    consented: async () => hasConsent(db, tenantId, scopeFor('reddit')),
    callsLastHour: async since => (db.prepare(CALLS_LAST_HOUR_SQL).get(tenantId, since) as { n: number }).n,
    session: async () => getEnabledCredential(db, tenantId, connectorId('reddit'), deps.master),
    audit: async a => audit(db, a),
  }, tenantId, jobId, deps)
}
export function gatherCompetitorComplaints(db: Db, tenantId: string, jobId: string, deps: ComplaintDeps = {}): Promise<ComplaintItem[]> {
  return complaints({
    competitors: () => readCompetitors(db, tenantId),
    consented: () => readConsent(db, tenantId, scopeFor('reddit')),
    callsLastHour: async since => Number((await db.get<{ n: number }>(CALLS_LAST_HOUR_SQL, [tenantId, since]))!.n),
    session: () => readEnabledCredential(db, tenantId, connectorId('reddit'), deps.master),
    audit: a => writeAudit(db, a),
  }, tenantId, jobId, deps)
}

// After leads are written: any lead citing a complaint post gets the
// "complained about <competitor>" badge merged into its signals (never overwritten).
const BADGE_FIND_SQL = 'SELECT id, signals FROM leads WHERE scan_job_id = ? AND source_url = ?'
const BADGE_SET_SQL = 'UPDATE leads SET signals = ? WHERE id = ?'
// the lead's signals with the badge added, or null when it already has it
function withBadge(signals: string | null, tag: string): string | null {
  let sig: string[] = []
  try { const p = JSON.parse(signals || '[]'); if (Array.isArray(p)) sig = p.filter(x => typeof x === 'string') } catch { sig = [] }
  return sig.includes(tag) ? null : JSON.stringify([...sig, tag])
}
export function badgeComplaintLeads(db: Database.Database, jobId: string, complaints: { url: string; complaint_of: string }[]): number {
  let n = 0
  const find = db.prepare(BADGE_FIND_SQL)
  const upd = db.prepare(BADGE_SET_SQL)
  for (const c of complaints) {
    for (const r of find.all(jobId, c.url) as { id: string; signals: string | null }[]) {
      const next = withBadge(r.signals, `complained about ${c.complaint_of}`)
      if (next === null) continue
      upd.run(next, r.id)
      n++
    }
  }
  return n
}
export function writeComplaintBadges(db: Db, jobId: string, complaints: { url: string; complaint_of: string }[]): Promise<number> {
  return db.tx(function* (t: Tx): TxBody<number> {
    let n = 0
    for (const c of complaints) {
      for (const r of yield* t.all<{ id: string; signals: string | null }>(BADGE_FIND_SQL, [jobId, c.url])) {
        const next = withBadge(r.signals, `complained about ${c.complaint_of}`)
        if (next === null) continue
        yield* t.run(BADGE_SET_SQL, [next, r.id])
        n++
      }
    }
    return n
  })
}
