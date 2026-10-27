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
CREATE TRIGGER IF NOT EXISTS lead_evidence_copies_delete_only_expired BEFORE DELETE ON lead_evidence_copies
  WHEN OLD.expires_at > CAST(strftime('%s','now') AS INTEGER)
  BEGIN SELECT RAISE(ABORT, 'evidence copy is still within its retention period'); END;`)
}

// Expired rows are the only rows that can be deleted (the trigger enforces it).
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
  db.prepare('INSERT OR IGNORE INTO lead_evidence_copies (id, tenant_id, job_id, attempt, source_url, canonical_url, sha256, text, byte_length, fetched_at, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(randomBytes(12).toString('hex'), tenantId, jobId, attempt, page.url, canon, sha, page.text, Buffer.byteLength(page.text), page.heldAt, now, now + RETENTION_DAYS * 86_400)
  return (db.prepare('SELECT id FROM lead_evidence_copies WHERE tenant_id = ? AND job_id = ? AND attempt = ? AND canonical_url = ?').get(tenantId, jobId, attempt, canon) as { id: string }).id
}

export interface EvidenceCopyView { id: string; lead_id: string; job_id: string; attempt: number; source_url: string; sha256: string; fetched_at: number; expires_at: number; text: string; own_fetch_failure: string | null; integrity: 'ok' | 'mismatch' }
// Tenant-scoped read through the lead (and its job's owner); an expired or foreign record is simply absent.
export function evidenceCopyForLead(db: Database.Database, tenantId: string, leadId: string): EvidenceCopyView | null {
  const r = db.prepare(`SELECT c.id, l.id AS lead_id, c.job_id, c.attempt, c.source_url, c.sha256, c.fetched_at, c.expires_at, c.text, l.own_fetch_failure
    FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id JOIN lead_evidence_copies c ON c.id = l.evidence_copy_id
    WHERE l.id = ? AND j.user_id = ? AND c.tenant_id = ? AND c.job_id = j.id AND c.expires_at > CAST(strftime('%s','now') AS INTEGER)`).get(leadId, tenantId, tenantId) as Omit<EvidenceCopyView, 'integrity'> | undefined
  if (!r) return null
  return { ...r, integrity: createHash('sha256').update(r.text).digest('hex') === r.sha256 ? 'ok' : 'mismatch' }
}
