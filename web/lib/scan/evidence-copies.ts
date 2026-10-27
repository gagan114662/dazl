// Immutable, tenant-scoped record of the exact text a lead was verified against when dazl could not read the page itself
// (lib/scan/held-text.ts). One row per (tenant, job, attempt, canonical url), linked from leads.evidence_copy_id. The text is stored
// as received, never rewritten. Bounded: a copy over MAX_COPY_BYTES is not used for verification at all (so every used copy is
// preserved whole), rows expire after RETENTION_DAYS and a tenant holds at most MAX_TENANT_COPIES unexpired rows.
import { randomBytes, createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { canonicalUrl } from './evidence-origin.ts'

export interface HeldPageRecord { url: string; title: string; text: string; sha256: string; heldAt: number }

export const MAX_COPY_BYTES = 256 * 1024 // = held-text.ts MAX_COPY_BYTES (a test pins it)
export const RETENTION_DAYS = 90
export const MAX_TENANT_COPIES = 300

export function migrateEvidenceCopies(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS lead_evidence_copies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  source_url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '' CHECK (length(CAST(title AS BLOB)) <= 1024),
  title_sha256 TEXT NOT NULL CHECK (length(title_sha256) = 64),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  text TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length <= ${MAX_COPY_BYTES}),
  fetched_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
  expires_at INTEGER NOT NULL,
  UNIQUE (tenant_id, job_id, attempt, canonical_url)
);
CREATE INDEX IF NOT EXISTS idx_evidence_copies_tenant ON lead_evidence_copies(tenant_id, expires_at);
CREATE TRIGGER IF NOT EXISTS lead_evidence_copies_no_update BEFORE UPDATE ON lead_evidence_copies
  BEGIN SELECT RAISE(ABORT, 'evidence copies are immutable'); END;
-- A tenant's gate row exists only inside purgeTenantEvidence's transaction; a delete of an unexpired row needs THAT tenant's gate.
CREATE TABLE IF NOT EXISTS evidence_purge_gate (tenant_id TEXT PRIMARY KEY);
DROP TRIGGER IF EXISTS lead_evidence_copies_delete_only_expired;
CREATE TRIGGER lead_evidence_copies_delete_only_expired BEFORE DELETE ON lead_evidence_copies
  WHEN OLD.expires_at > CAST(strftime('%s','now') AS INTEGER)
   AND NOT EXISTS (SELECT 1 FROM evidence_purge_gate g WHERE g.tenant_id = OLD.tenant_id)
  BEGIN SELECT RAISE(ABORT, 'evidence copy is still within its retention period'); END;
-- Append-only record of every purge: who, why, what, when. Never edited or removed.
CREATE TABLE IF NOT EXISTS evidence_purge_audit (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  operator TEXT NOT NULL CHECK (length(operator) BETWEEN 2 AND 120),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  copies_deleted INTEGER NOT NULL,
  bytes_deleted INTEGER NOT NULL,
  leads_unlinked INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);
CREATE TRIGGER IF NOT EXISTS evidence_purge_audit_no_update BEFORE UPDATE ON evidence_purge_audit BEGIN SELECT RAISE(ABORT, 'purge audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS evidence_purge_audit_no_delete BEFORE DELETE ON evidence_purge_audit BEGIN SELECT RAISE(ABORT, 'purge audit is append-only'); END;`)
}

// Expired rows are the only rows that can be deleted (the trigger enforces it).
export interface PurgeResult { dryRun: boolean; tenantId: string; copies: number; bytes: number; leads: number; auditId: string | null }
// The ONLY way to remove unexpired evidence: an operator honouring a tenant's deletion request. Not reachable from any HTTP route.
// Requires an operator name, a written reason and the tenant id repeated as confirmation; dry-run by default (counts only).
// One transaction: open THIS tenant's gate, delete THIS tenant's copies, unlink and mark its leads, close the gate, write the audit
// row. The trigger refuses any other tenant's rows even while the gate is open, and ordinary code never opens a gate.
export function purgeTenantEvidence(db: Database.Database, o: { tenantId: string; operator: string; reason: string; confirmTenantId: string; execute?: boolean }, now = Math.floor(Date.now() / 1000)): PurgeResult {
  const operator = (o.operator ?? '').trim(), reason = (o.reason ?? '').trim()
  if (!o.tenantId || o.confirmTenantId !== o.tenantId) throw new Error('purge refused: confirmation does not match the tenant id')
  if (operator.length < 2 || reason.length < 10) throw new Error('purge refused: an operator name and a written reason (10+ characters) are required')
  const count = () => db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(byte_length), 0) AS b FROM lead_evidence_copies WHERE tenant_id = ?').get(o.tenantId) as { n: number; b: number }
  const linked = () => (db.prepare('SELECT COUNT(*) AS n FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.user_id = ? AND l.evidence_copy_id IS NOT NULL').get(o.tenantId) as { n: number }).n
  if (!o.execute) { const c = count(); return { dryRun: true, tenantId: o.tenantId, copies: c.n, bytes: c.b, leads: linked(), auditId: null } }
  return db.transaction((): PurgeResult => {
    const c = count(), leads = linked()
    db.prepare('INSERT INTO evidence_purge_gate (tenant_id) VALUES (?)').run(o.tenantId)
    try {
      db.prepare('DELETE FROM lead_evidence_copies WHERE tenant_id = ?').run(o.tenantId)
      // Only this tenant's leads (through the job owner) lose the link; they keep their verification record and origin label,
      // and are marked so no response claims the copy is still available.
      db.prepare('UPDATE leads SET evidence_copy_id = NULL, evidence_purged_at = ? WHERE evidence_copy_id IS NOT NULL AND scan_job_id IN (SELECT id FROM scan_jobs WHERE user_id = ?)').run(now, o.tenantId)
    } finally { db.prepare('DELETE FROM evidence_purge_gate WHERE tenant_id = ?').run(o.tenantId) }
    const auditId = randomBytes(12).toString('hex')
    db.prepare('INSERT INTO evidence_purge_audit (id, tenant_id, operator, reason, copies_deleted, bytes_deleted, leads_unlinked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(auditId, o.tenantId, operator, reason, c.n, c.b, leads, now)
    return { dryRun: false, tenantId: o.tenantId, copies: c.n, bytes: c.b, leads, auditId }
  }).immediate()
}

export function purgeExpiredEvidenceCopies(db: Database.Database, tenantId?: string): number {
  return db.prepare(`DELETE FROM lead_evidence_copies WHERE expires_at <= CAST(strftime('%s','now') AS INTEGER)${tenantId ? ' AND tenant_id = ?' : ''}`).run(...(tenantId ? [tenantId] : [])).changes
}

// How many more copies this tenant may keep right now (after dropping expired ones).
export function evidenceCopyRoom(db: Database.Database, tenantId: string): number {
  try {
    purgeExpiredEvidenceCopies(db, tenantId)
    const n = (db.prepare('SELECT COUNT(*) AS n FROM lead_evidence_copies WHERE tenant_id = ?').get(tenantId) as { n: number }).n
    return Math.max(0, MAX_TENANT_COPIES - n)
  } catch { return 0 } // no table / storage trouble: no room, so no copy is used
}

export function storeEvidenceCopy(db: Database.Database, tenantId: string, jobId: string, attempt: number, page: HeldPageRecord, now = Math.floor(Date.now() / 1000)): string {
  const canon = canonicalUrl(page.url)
  if (!canon) throw new Error('evidence copy url invalid')
  const sha = createHash('sha256').update(page.text).digest('hex')
  if (sha !== page.sha256) throw new Error('evidence copy hash mismatch')
  // The title is evidence too: the verifier accepts the company named in the page TITLE, so the exact title is stored and hashed
  // beside the body in the same immutable row.
  const title = page.title ?? ''
  const titleSha = createHash('sha256').update(title).digest('hex')
  db.prepare('INSERT OR IGNORE INTO lead_evidence_copies (id, tenant_id, job_id, attempt, source_url, canonical_url, title, title_sha256, sha256, text, byte_length, fetched_at, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(randomBytes(12).toString('hex'), tenantId, jobId, attempt, page.url, canon, title, titleSha, sha, page.text, Buffer.byteLength(page.text), page.heldAt, now, now + RETENTION_DAYS * 86_400)
  return (db.prepare('SELECT id FROM lead_evidence_copies WHERE tenant_id = ? AND job_id = ? AND attempt = ? AND canonical_url = ?').get(tenantId, jobId, attempt, canon) as { id: string }).id
}

export interface EvidenceCopyView { id: string; lead_id: string; job_id: string; attempt: number; source_url: string; title: string; title_sha256: string; sha256: string; fetched_at: number; expires_at: number; text: string; own_fetch_failure: string | null; integrity: 'ok' | 'mismatch' }
// Tenant-scoped read through the lead (and its job's owner); an expired or foreign record is simply absent.
export function evidenceCopyForLead(db: Database.Database, tenantId: string, leadId: string): EvidenceCopyView | null {
  const r = db.prepare(`SELECT c.id, l.id AS lead_id, c.job_id, c.attempt, c.source_url, c.title, c.title_sha256, c.sha256, c.fetched_at, c.expires_at, c.text, l.own_fetch_failure
    FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id JOIN lead_evidence_copies c ON c.id = l.evidence_copy_id
    WHERE l.id = ? AND j.user_id = ? AND c.tenant_id = ? AND c.job_id = j.id AND c.expires_at > CAST(strftime('%s','now') AS INTEGER)`).get(leadId, tenantId, tenantId) as Omit<EvidenceCopyView, 'integrity'> | undefined
  if (!r) return null
  return { ...r, integrity: createHash('sha256').update(r.text).digest('hex') === r.sha256 && createHash('sha256').update(r.title).digest('hex') === r.title_sha256 ? 'ok' : 'mismatch' }
}

// Was this lead's copied text deleted on request? (Distinct from "never had one" and from "expired".)
export function evidencePurgedAt(db: Database.Database, tenantId: string, leadId: string): number | null {
  const r = db.prepare('SELECT l.evidence_purged_at AS t FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?').get(leadId, tenantId) as { t: number | null } | undefined
  return r?.t ?? null
}
