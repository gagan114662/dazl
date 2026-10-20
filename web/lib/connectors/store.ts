import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { decryptSecret, encryptSecret } from '../secrets.ts'

// Per-tenant connector credentials, encrypted with the same envelope scheme as LLM keys.
// A connector runs only when the tenant saved credentials AND turned it on.
export function migrateConnectors(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_connectors (
      tenant_id    TEXT NOT NULL,
      connector    TEXT NOT NULL,
      ciphertext   TEXT NOT NULL,
      last4        TEXT NOT NULL,
      enabled      INTEGER NOT NULL DEFAULT 1,
      created_at   INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      PRIMARY KEY (tenant_id, connector)
    );
    CREATE TABLE IF NOT EXISTS connector_audit (
      id         TEXT PRIMARY KEY,
      tenant_id  TEXT NOT NULL,
      connector  TEXT NOT NULL,
      scan_job_id TEXT,
      lookup     TEXT NOT NULL CHECK (length(lookup) <= 200),
      status     TEXT NOT NULL,
      results    INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );
    CREATE INDEX IF NOT EXISTS connector_audit_tenant ON connector_audit (tenant_id, created_at);
    -- Enriched fields live beside the lead, never over it. A row needs a source URL and a source date.
    CREATE TABLE IF NOT EXISTS lead_enrichments (
      id          TEXT PRIMARY KEY,
      lead_id     TEXT NOT NULL,
      tenant_id   TEXT NOT NULL,
      connector   TEXT NOT NULL,
      kind        TEXT NOT NULL,
      value       TEXT NOT NULL CHECK (length(value) <= 254),
      label       TEXT CHECK (label IS NULL OR length(label) <= 200),
      confidence  INTEGER,
      source_url  TEXT NOT NULL CHECK (length(source_url) <= 500 AND source_url LIKE 'http%'),
      source_date TEXT NOT NULL CHECK (length(source_date) = 10),
      retrieved_at INTEGER NOT NULL,
      UNIQUE (lead_id, connector, kind, value)
    );
    CREATE INDEX IF NOT EXISTS lead_enrichments_lead ON lead_enrichments (lead_id);
  `)
}

const ctx = (tenantId: string, connector: string) => `connector:${tenantId}:${connector}`

export function saveCredential(db: Database.Database, tenantId: string, connector: string, secret: string, master?: Buffer): void {
  db.prepare(
    `INSERT INTO tenant_connectors (tenant_id, connector, ciphertext, last4, enabled) VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(tenant_id, connector) DO UPDATE SET ciphertext = excluded.ciphertext, last4 = excluded.last4, enabled = 1`,
  ).run(tenantId, connector, encryptSecret(secret, ctx(tenantId, connector), master), secret.slice(-4))
}

// Safe for the browser: never includes the credential or ciphertext.
export function connectorStatus(db: Database.Database, tenantId: string) {
  return (db.prepare('SELECT connector, last4, enabled FROM tenant_connectors WHERE tenant_id = ?').all(tenantId) as { connector: string; last4: string; enabled: number }[]).map(r => ({ connector: r.connector, last4: r.last4, enabled: r.enabled === 1 }))
}

export function setEnabled(db: Database.Database, tenantId: string, connector: string, enabled: boolean): boolean {
  return db.prepare('UPDATE tenant_connectors SET enabled = ? WHERE tenant_id = ? AND connector = ?').run(enabled ? 1 : 0, tenantId, connector).changes === 1
}

export function deleteCredential(db: Database.Database, tenantId: string, connector: string): boolean {
  return db.prepare('DELETE FROM tenant_connectors WHERE tenant_id = ? AND connector = ?').run(tenantId, connector).changes === 1
}

// Server-side only. Returns null unless the tenant has the connector saved and enabled.
export function getEnabledCredential(db: Database.Database, tenantId: string, connector: string, master?: Buffer): string | null {
  const r = db.prepare('SELECT ciphertext FROM tenant_connectors WHERE tenant_id = ? AND connector = ? AND enabled = 1').get(tenantId, connector) as { ciphertext: string } | undefined
  return r ? decryptSecret(r.ciphertext, ctx(tenantId, connector), master) : null
}

export function audit(db: Database.Database, a: { tenantId: string; connector: string; jobId?: string | null; lookup: string; status: string; results: number }): void {
  db.prepare('INSERT INTO connector_audit (id, tenant_id, connector, scan_job_id, lookup, status, results) VALUES (?, ?, ?, ?, ?, ?, ?)').run(randomBytes(12).toString('hex'), a.tenantId, a.connector, a.jobId ?? null, a.lookup.slice(0, 200), a.status, a.results)
}

export function recentAudit(db: Database.Database, tenantId: string, limit = 20) {
  return db.prepare('SELECT connector, scan_job_id, lookup, status, results, created_at FROM connector_audit WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(tenantId, limit)
}

export interface Enrichment { connector: string; kind: string; value: string; label: string | null; confidence: number | null; source_url: string; source_date: string; retrieved_at: number }

export function addEnrichment(db: Database.Database, tenantId: string, leadId: string, e: Enrichment): void {
  db.prepare(
    `INSERT OR IGNORE INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomBytes(12).toString('hex'), leadId, tenantId, e.connector, e.kind, e.value, e.label, e.confidence, e.source_url, e.source_date, e.retrieved_at)
}

export function enrichmentsForLeads(db: Database.Database, tenantId: string, leadIds: string[]): Record<string, Enrichment[]> {
  const out: Record<string, Enrichment[]> = {}
  if (leadIds.length === 0) return out
  const rows = db.prepare(`SELECT lead_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at FROM lead_enrichments WHERE tenant_id = ? AND lead_id IN (${leadIds.map(() => '?').join(',')})`).all(tenantId, ...leadIds) as (Enrichment & { lead_id: string })[]
  for (const { lead_id, ...e } of rows) (out[lead_id] ??= []).push(e)
  return out
}
