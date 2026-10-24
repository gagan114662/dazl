// Gated execution of a saved-lead qualification. Disabled unless the caller says it is enabled, and even then
// it needs an approval bound to the exact prompt hash, vendor, model, estimate and limits. One claim row per
// (tenant, lead, prompt hash) means a repeat click, a retry or a race can never make a second paid request.
import type Database from 'better-sqlite3'
import type { Provider } from '@/lib/llm/provider'
import { qualifyLead, DEFAULT_LIMITS, type PaidApproval, type Qualification } from './lead-qualify.ts'
import { qualifyPreview, type PageFetcher } from './qualify-preview.ts'
import { fetchPageDetailed } from './fetch-page.ts'

export function migrateQualify(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS lead_qualifications (
    tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL, prompt_sha256 TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running','done','failed')),
    vendor TEXT, model TEXT, served_model TEXT, result TEXT, usage TEXT, error TEXT, evidence TEXT,
    created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
    UNIQUE (tenant_id, lead_id, prompt_sha256))`)
  if (!(db.prepare("PRAGMA table_info(lead_qualifications)").all() as { name: string }[]).some(c => c.name === 'evidence')) db.exec('ALTER TABLE lead_qualifications ADD COLUMN evidence TEXT')
}

export interface StoredQualification { prompt_sha256: string; status: 'running' | 'done' | 'failed'; vendor: string | null; model: string | null; qualification: Qualification | null; usage: unknown; error: string | null; created_at: number; evidence: unknown }

export function storedQualifications(db: Database.Database, userId: string, leadId: string): StoredQualification[] {
  migrateQualify(db)
  const rows = db.prepare(`SELECT q.prompt_sha256, q.status, q.vendor, q.model, q.result, q.usage, q.error, q.created_at, q.evidence
    FROM lead_qualifications q JOIN leads l ON l.id = q.lead_id JOIN scan_jobs j ON j.id = l.scan_job_id
    WHERE q.lead_id = ? AND q.tenant_id = ? AND j.user_id = ? ORDER BY q.created_at DESC`).all(leadId, userId, userId) as
    { prompt_sha256: string; status: StoredQualification['status']; vendor: string | null; model: string | null; result: string | null; usage: string | null; error: string | null; created_at: number; evidence: string | null }[]
  return rows.map(r => ({ prompt_sha256: r.prompt_sha256, status: r.status, vendor: r.vendor, model: r.model, qualification: r.result ? JSON.parse(r.result) as Qualification : null, usage: r.usage ? JSON.parse(r.usage) : null, error: r.error, created_at: r.created_at, evidence: r.evidence ? JSON.parse(r.evidence) : null }))
}

export type RunResult =
  | { status: 'disabled' }
  | { status: 'blocked'; reason: string }
  | { status: 'exists'; stored: StoredQualification }
  | { status: 'done'; stored: StoredQualification }
  | { status: 'failed'; error: string }

export interface RunDeps { enabled: boolean; sellerText: string; vendor: string | null; provider: Provider | null; apiKey: string | null; fetchPage?: PageFetcher; fetchImpl?: typeof fetch }

export async function runQualification(db: Database.Database, userId: string, leadId: string, approval: PaidApproval, d: RunDeps): Promise<RunResult> {
  if (!d.enabled) return { status: 'disabled' }
  if (!d.vendor || !d.provider || !d.apiKey) return { status: 'blocked', reason: 'no_usable_key' }
  migrateQualify(db)
  const model = d.provider.configuredModel ? d.provider.configuredModel() : null
  const prev = await qualifyPreview(db, userId, leadId, d.sellerText, d.fetchPage ?? fetchPageDetailed, d.vendor, model)
  if (!prev || !prev.input) return { status: 'blocked', reason: prev ? 'no_evidence' : 'not_found' }
  if (!prev.ready) return { status: 'blocked', reason: 'not_ready' }
  // Any earlier claim for this lead (running, done or failed, whatever page content it was made on) blocks a new paid
  // request: changed page text produces a new hash, and that must not quietly buy a second call.
  const existing = storedQualifications(db, userId, leadId)[0]
  if (existing) return { status: 'exists', stored: existing }
  // Claim before the request. A second caller hits the unique key and gets 'exists'.
  const claim = db.prepare("INSERT OR IGNORE INTO lead_qualifications (tenant_id, lead_id, prompt_sha256, status, vendor, model, evidence) VALUES (?, ?, ?, 'running', ?, ?, ?)").run(userId, leadId, prev.prompt_sha256 ?? '', d.vendor, model, JSON.stringify({ scope: prev.scope, pages: prev.pages, cost: prev.cost, limits: DEFAULT_LIMITS, approval: { max_usd_estimate: approval.max_usd_estimate } }))
  if (claim.changes === 0) { const s = storedQualifications(db, userId, leadId).find(x => x.prompt_sha256 === prev.prompt_sha256); return s ? { status: 'exists', stored: s } : { status: 'blocked', reason: 'claim_lost' } }
  try {
    const r = await qualifyLead(d.provider, d.apiKey, prev.input, { vendor: d.vendor, approval, limits: DEFAULT_LIMITS, fetchImpl: d.fetchImpl })
    if (r.status !== 'done') { db.prepare("DELETE FROM lead_qualifications WHERE tenant_id=? AND lead_id=? AND prompt_sha256=? AND status='running'").run(userId, leadId, prev.prompt_sha256 ?? ''); return { status: 'blocked', reason: r.status === 'blocked' ? r.reason : r.status } }
    db.prepare("UPDATE lead_qualifications SET status='done', result=?, usage=?, served_model=? WHERE tenant_id=? AND lead_id=? AND prompt_sha256=?").run(JSON.stringify(r.qualification), JSON.stringify(r.usage ?? null), r.served_model, userId, leadId, prev.prompt_sha256 ?? '')
    return { status: 'done', stored: storedQualifications(db, userId, leadId).find(x => x.prompt_sha256 === prev.prompt_sha256)! }
  } catch (e) {
    // The request may have been billed. Keep the row as failed so nothing repeats it automatically.
    const msg = e instanceof Error ? e.message.slice(0, 200) : 'error'
    db.prepare("UPDATE lead_qualifications SET status='failed', error=? WHERE tenant_id=? AND lead_id=? AND prompt_sha256=?").run(msg, userId, leadId, prev.prompt_sha256 ?? '')
    return { status: 'failed', error: msg }
  }
}
