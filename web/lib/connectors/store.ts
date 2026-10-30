import { randomBytes } from 'node:crypto'
import { migrateInsertionOrder } from '../db/insertion-order.ts'
import type Database from 'better-sqlite3'
import type { Db } from '../db/client.ts'
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
    -- One claim per tenant, CRM provider and lead (lib/crm/index.ts, #365): taken before a native CRM create is sent,
    -- so two requests or two workers can never both send it, and an unknown outcome blocks a retry until the user
    -- resolves it, across restarts and key changes. attempt_id fences the request that holds the claim.
    CREATE TABLE IF NOT EXISTS crm_push_claims (
      tenant_id   TEXT NOT NULL,
      destination TEXT NOT NULL,
      lead_id     TEXT NOT NULL,
      status      TEXT NOT NULL CHECK (status IN ('pending', 'ok', 'failed', 'uncertain', 'resolved_created', 'resolved_not_created')),
      external_id TEXT,
      attempt_id  TEXT NOT NULL,
      claimed_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, destination, lead_id)
    );
  `)
  migrateInsertionOrder(db, ['lead_enrichments', 'connector_audit']) // insert_seq (lib/db/insertion-order.ts)
}

const ctx = (tenantId: string, connector: string) => `connector:${tenantId}:${connector}`

// The settings routes run on the Db layer (SQLite or Postgres); the scan pipeline and the CRM still write on the raw
// handle. Where both need a write, the sync and async versions share one SQL string and one argument builder.
const SAVE_CREDENTIAL_SQL = `INSERT INTO tenant_connectors (tenant_id, connector, ciphertext, last4, enabled) VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(tenant_id, connector) DO UPDATE SET ciphertext = excluded.ciphertext, last4 = excluded.last4, enabled = 1`
const credentialArgs = (tenantId: string, connector: string, secret: string, master?: Buffer) =>
  [tenantId, connector, encryptSecret(secret, ctx(tenantId, connector), master), secret.slice(-4)]
export function saveCredential(db: Database.Database, tenantId: string, connector: string, secret: string, master?: Buffer): void {
  db.prepare(SAVE_CREDENTIAL_SQL).run(...credentialArgs(tenantId, connector, secret, master))
}
export async function writeCredential(db: Db, tenantId: string, connector: string, secret: string, master?: Buffer): Promise<void> {
  await db.run(SAVE_CREDENTIAL_SQL, credentialArgs(tenantId, connector, secret, master))
}

// Safe for the browser: never includes the credential or ciphertext. By connector, the order SQLite's primary-key
// index gave; Postgres has no implicit order.
export async function connectorStatus(db: Db, tenantId: string) {
  return (await db.all<{ connector: string; last4: string; enabled: number }>('SELECT connector, last4, enabled FROM tenant_connectors WHERE tenant_id = ? ORDER BY connector', [tenantId]))
    .map(r => ({ connector: r.connector, last4: r.last4, enabled: Number(r.enabled) === 1 }))
}

export async function setEnabled(db: Db, tenantId: string, connector: string, enabled: boolean): Promise<boolean> {
  return (await db.run('UPDATE tenant_connectors SET enabled = ? WHERE tenant_id = ? AND connector = ?', [enabled ? 1 : 0, tenantId, connector])).changes === 1
}

const DELETE_CREDENTIAL_SQL = 'DELETE FROM tenant_connectors WHERE tenant_id = ? AND connector = ?'
export function deleteCredential(db: Database.Database, tenantId: string, connector: string): boolean {
  return db.prepare(DELETE_CREDENTIAL_SQL).run(tenantId, connector).changes === 1
}
export async function removeCredential(db: Db, tenantId: string, connector: string): Promise<boolean> {
  return (await db.run(DELETE_CREDENTIAL_SQL, [tenantId, connector])).changes === 1
}

// Server-side only. Returns null unless the tenant has the connector saved and enabled.
const ENABLED_CREDENTIAL_SQL = 'SELECT ciphertext FROM tenant_connectors WHERE tenant_id = ? AND connector = ? AND enabled = 1'
export function getEnabledCredential(db: Database.Database, tenantId: string, connector: string, master?: Buffer): string | null {
  const r = db.prepare(ENABLED_CREDENTIAL_SQL).get(tenantId, connector) as { ciphertext: string } | undefined
  return r ? decryptSecret(r.ciphertext, ctx(tenantId, connector), master) : null
}
export async function readEnabledCredential(db: Db, tenantId: string, connector: string, master?: Buffer): Promise<string | null> {
  const r = await db.get<{ ciphertext: string }>(ENABLED_CREDENTIAL_SQL, [tenantId, connector])
  return r ? decryptSecret(r.ciphertext, ctx(tenantId, connector), master) : null
}

export type AuditEntry = { tenantId: string; connector: string; jobId?: string | null; lookup: string; status: string; results: number }
const AUDIT_SQL = 'INSERT INTO connector_audit (id, tenant_id, connector, scan_job_id, lookup, status, results) VALUES (?, ?, ?, ?, ?, ?, ?)'
const auditArgs = (a: AuditEntry) => [randomBytes(12).toString('hex'), a.tenantId, a.connector, a.jobId ?? null, a.lookup.slice(0, 200), a.status, a.results]
export function audit(db: Database.Database, a: AuditEntry): void {
  db.prepare(AUDIT_SQL).run(...auditArgs(a))
}
export async function writeAudit(db: Db, a: AuditEntry): Promise<void> {
  await db.run(AUDIT_SQL, auditArgs(a))
}

// Newest first; same-second rows newest-inserted first (insert_seq: the order rowid gave). Sync for the pipeline's
// tests and tools on the raw handle; readRecentAudit for the settings routes.
const RECENT_AUDIT_SQL = 'SELECT connector, scan_job_id, lookup, status, results, created_at FROM connector_audit WHERE tenant_id = ? ORDER BY created_at DESC, insert_seq DESC LIMIT ?'
export function recentAudit(db: Database.Database, tenantId: string, limit = 20) {
  return db.prepare(RECENT_AUDIT_SQL).all(tenantId, limit)
}
export function readRecentAudit(db: Db, tenantId: string, limit = 20) {
  return db.all(RECENT_AUDIT_SQL, [tenantId, limit])
}

export interface Enrichment { connector: string; kind: string; value: string; label: string | null; confidence: number | null; source_url: string; source_date: string; retrieved_at: number }

export function addEnrichment(db: Database.Database, tenantId: string, leadId: string, e: Enrichment): void {
  db.prepare(
    `INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (lead_id, connector, kind, value) DO NOTHING`,
  ).run(randomBytes(12).toString('hex'), leadId, tenantId, e.connector, e.kind, e.value, e.label, e.confidence, e.source_url, e.source_date, e.retrieved_at)
}

export function enrichmentsForLeads(db: Database.Database, tenantId: string, leadIds: string[]): Record<string, Enrichment[]> {
  const out: Record<string, Enrichment[]> = {}
  if (leadIds.length === 0) return out
  const rows = db.prepare(`SELECT lead_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at FROM lead_enrichments WHERE tenant_id = ? AND lead_id IN (${leadIds.map(() => '?').join(',')})`).all(tenantId, ...leadIds) as (Enrichment & { lead_id: string })[]
  for (const { lead_id, ...e } of rows) (out[lead_id] ??= []).push(e)
  return out
}
