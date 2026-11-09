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
import { hasConsent, httpWorker, readConsent, type WorkerAuthor, type WorkerFetch } from '../advanced/index.ts'

export const MAX_COMPETITORS = 5
const MAX_POST_AGE_DAYS = 30
export const COMPLAINT_CONNECTOR = 'adv:reddit-competitor'
export const COMPLAINT_CONNECTOR_X = 'adv:x-competitor'
// Complaint search runs on each platform whose fetcher can carry the post's own author. X's payload carries the
// author's profile website - the poster's SELF-ASSERTED claim, captured as attributed context for review, never
// verification of affiliation; Reddit carries only a username. On both platforms a post ends at needs_evidence
// with the explicit unavailable reason unless the source reports an actual company (#401/#379 reviewer decision).
const COMPLAINT_PLATFORMS: { platform: 'reddit' | 'x'; connector: string }[] = [
  { platform: 'reddit', connector: COMPLAINT_CONNECTOR },
  { platform: 'x', connector: COMPLAINT_CONNECTOR_X },
]

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
  try { return (await db.all<{ name: string }>(COMPETITORS_SQL, [tenantId])).map(r => r.name) }
  catch (e) { if (e instanceof Error && /no such table|does not exist/i.test(e.message)) return [] /* a store that predates the table: no list */ ; throw e }
}
// Strict variant for rubric/exclusion reads: null when the list is UNREADABLE (a missing/drifted table, any store
// error); [] only when it is genuinely empty. An unreadable exclusion list must never read as "no exclusions"
// (#401 review: fail closed, never promote an excluded vendor while the exclusion state cannot be read).
export async function readCompetitorsStrict(db: Db, tenantId: string): Promise<string[] | null> {
  try { return (await db.all<{ name: string }>(COMPETITORS_SQL, [tenantId])).map(r => r.name) }
  catch { return null }
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

// Connector audit rows share the per-platform hourly budget with the platform's normal
// fetcher: complaint searches count as adv:<platform> calls so the two never stack.
const callsLastHourSql = (platform: 'reddit' | 'x'): string =>
  `SELECT COUNT(*) AS n FROM connector_audit WHERE tenant_id = ? AND connector IN ('adv:${platform}', 'adv:${platform}-competitor') AND created_at > ?`

export interface ComplaintItem extends Evidence { login_walled: boolean; complaint_of: string; author?: WorkerAuthor }
type ComplaintDeps = { worker?: WorkerFetch; master?: Buffer; env?: Record<string, string | undefined>; now?: number }

// The store reads and writes one complaint search needs; a sync raw handle or the Db layer behind the same steps.
// Consent, budget and session are per platform - an X complaint search never spends Reddit's consent or calls.
interface ComplaintStore {
  competitors(): Promise<string[]>
  consented(platform: 'reddit' | 'x'): Promise<boolean>
  callsLastHour(platform: 'reddit' | 'x', since: number): Promise<number>
  session(platform: 'reddit' | 'x'): Promise<string | null>
  audit(a: AuditEntry): Promise<void>
}
async function complaints(store: ComplaintStore, tenantId: string, jobId: string, deps: ComplaintDeps): Promise<ComplaintItem[]> {
  const env = deps.env ?? process.env
  const competitors = (await store.competitors()).slice(0, MAX_COMPETITORS)
  if (competitors.length === 0) return []
  const worker = deps.worker ?? httpWorker(env)
  const cutoff = Date.now() - MAX_POST_AGE_DAYS * 86400_000
  const now = deps.now ?? Math.floor(Date.now() / 1000)
  const out: ComplaintItem[] = []
  for (const { platform, connector } of COMPLAINT_PLATFORMS) {
    const skip = (status: string) => store.audit({ tenantId, connector, jobId, lookup: `${competitors.length} competitors`, status, results: 0 })
    if (!platformAllowed(platform, advFlags(env))) { await skip('disabled'); continue }
    if (!(await store.consented(platform))) { await skip('no_consent'); continue }
    const budget = maxCallsPerHour(platform, env) - await store.callsLastHour(platform, now - 3600)
    if (budget <= 0) { await skip('rate_limited'); continue }
    const session = (await store.session(platform)) || ''
    for (const name of competitors.slice(0, budget)) {
      const q = complaintQuery(name)
      const r = await worker({ platform, query: q.slice(0, 300), session }).catch(() => null)
      if (r === null) { await store.audit({ tenantId, connector, jobId, lookup: q, status: 'worker_error', results: 0 }); continue }
      if ('failed' in r) { await store.audit({ tenantId, connector, jobId, lookup: q, status: r.failed, results: 0 }); continue }
      // Version skew: a worker refusal is 'unsupported', never a fake empty result.
      if (r.unsupported) { await store.audit({ tenantId, connector, jobId, lookup: q, status: 'unsupported', results: 0 }); continue }
      const items = r.items
      const fresh = items.filter(i => i.date && new Date(i.date).getTime() >= cutoff)
      await store.audit({ tenantId, connector, jobId, lookup: q, status: fresh.length ? 'ok' : 'empty', results: fresh.length })
      for (const it of fresh.slice(0, 10)) out.push({ source: connector, url: it.url, title: it.title, quote: it.quote, date: it.date, login_walled: it.login_walled, complaint_of: name, ...(it.author ? { author: it.author } : {}) })
    }
  }
  return out
}

// One worker search per configured competitor and platform. Never throws into the runner. Sync store on the raw
// handle (the runner today); gatherCompetitorComplaints is the same on the Db layer (the runner's storage port).
export function collectCompetitorComplaints(db: Database.Database, tenantId: string, jobId: string, deps: ComplaintDeps = {}): Promise<ComplaintItem[]> {
  return complaints({
    competitors: async () => listCompetitors(db, tenantId),
    consented: async p => hasConsent(db, tenantId, scopeFor(p)),
    callsLastHour: async (p, since) => (db.prepare(callsLastHourSql(p)).get(tenantId, since) as { n: number }).n,
    session: async p => getEnabledCredential(db, tenantId, connectorId(p), deps.master),
    audit: async a => audit(db, a),
  }, tenantId, jobId, deps)
}
export function gatherCompetitorComplaints(db: Db, tenantId: string, jobId: string, deps: ComplaintDeps = {}): Promise<ComplaintItem[]> {
  return complaints({
    competitors: () => readCompetitors(db, tenantId),
    consented: p => readConsent(db, tenantId, scopeFor(p)),
    callsLastHour: async (p, since) => Number((await db.get<{ n: number }>(callsLastHourSql(p), [tenantId, since]))!.n),
    session: p => readEnabledCredential(db, tenantId, connectorId(p), deps.master),
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
