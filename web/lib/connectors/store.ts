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
    -- Recovery (#382 follow-up): the org lookup's result, written in the SAME transaction as the claim's
    -- terminal settle. Presence is authoritative: memo == "agreement passed; the people step may resume".
    -- Immutable once set (the settle guards on status='reserved'); NULL forever on people/legacy claims.
    CREATE TABLE IF NOT EXISTS connector_claims (
      tenant_id   TEXT NOT NULL,
      connector   TEXT NOT NULL,
      scan_job_id TEXT NOT NULL,
      lookup      TEXT NOT NULL CHECK (length(lookup) <= 200),
      status      TEXT NOT NULL CHECK (status IN ('reserved','ok','empty','rejected')),
      claimed_at  INTEGER NOT NULL,
      settled_at  INTEGER,
      memo        TEXT,
      PRIMARY KEY (tenant_id, connector, scan_job_id, lookup)
    );
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
  // Existing stores: add the memo column (PG twin: migrations/pg/0036_connector_claim_memo.sql).
  try { db.exec('ALTER TABLE connector_claims ADD COLUMN memo TEXT') } catch { /* already present */ }
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
// index gave; Postgres has no implicit order. The secret-less 'enrich:fallback' opt-in flag row is not a connector
// and never surfaces here (connectors list, scan estimate vendors).
export async function connectorStatus(db: Db, tenantId: string) {
  return (await db.all<{ connector: string; last4: string; enabled: number }>("SELECT connector, last4, enabled FROM tenant_connectors WHERE tenant_id = ? AND connector != 'enrich:fallback' ORDER BY connector", [tenantId]))
    .map(r => ({ connector: r.connector, last4: r.last4, enabled: Number(r.enabled) === 1 }))
}

export async function setEnabled(db: Db, tenantId: string, connector: string, enabled: boolean): Promise<boolean> {
  return (await db.run('UPDATE tenant_connectors SET enabled = ? WHERE tenant_id = ? AND connector = ?', [enabled ? 1 : 0, tenantId, connector])).changes === 1
}

const DELETE_CREDENTIAL_SQL = 'DELETE FROM tenant_connectors WHERE tenant_id = ? AND connector = ?'
export function deleteCredential(db: Database.Database, tenantId: string, connector: string): boolean {
  return db.prepare(DELETE_CREDENTIAL_SQL).run(tenantId, connector).changes === 1
}
// The Apollo -> PDL fallback is a separate, OFF-by-default opt-in (#382): a PDL key saved under the original
// wording ("used only when no Apollo key is saved") is not consent to automatic paid fallback credits. The flag is
// a tenant_connectors row with no secret; it is never returned by getEnabledCredential and never listed as a key.
export const ENRICH_FALLBACK = 'enrich:fallback'
export function setEnrichFallback(db: Database.Database, tenantId: string, on: boolean): void {
  db.prepare("INSERT INTO tenant_connectors (tenant_id, connector, ciphertext, last4, enabled) VALUES (?, ?, '', '', ?) ON CONFLICT (tenant_id, connector) DO UPDATE SET enabled = excluded.enabled").run(tenantId, ENRICH_FALLBACK, on ? 1 : 0)
}
export async function writeEnrichFallback(db: Db, tenantId: string, on: boolean): Promise<void> {
  await db.run("INSERT INTO tenant_connectors (tenant_id, connector, ciphertext, last4, enabled) VALUES (?, ?, '', '', ?) ON CONFLICT (tenant_id, connector) DO UPDATE SET enabled = excluded.enabled", [tenantId, ENRICH_FALLBACK, on ? 1 : 0])
}
export function enrichFallbackEnabled(db: Database.Database, tenantId: string): boolean {
  return !!db.prepare("SELECT 1 FROM tenant_connectors WHERE tenant_id = ? AND connector = 'enrich:fallback' AND enabled = 1").get(tenantId)
}
export async function readEnrichFallbackEnabled(db: Db, tenantId: string): Promise<boolean> {
  return !!(await db.get("SELECT 1 FROM tenant_connectors WHERE tenant_id = ? AND connector = 'enrich:fallback' AND enabled = 1", [tenantId]))
}

export async function removeCredential(db: Db, tenantId: string, connector: string): Promise<boolean> {
  return (await db.run(DELETE_CREDENTIAL_SQL, [tenantId, connector])).changes === 1
}

// Server-side only. Returns null unless the tenant has the connector saved and enabled.
const ENABLED_CREDENTIAL_SQL = 'SELECT ciphertext FROM tenant_connectors WHERE tenant_id = ? AND connector = ? AND enabled = 1'
export function getEnabledCredential(db: Database.Database, tenantId: string, connector: string, master?: Buffer): string | null {
  const r = db.prepare(ENABLED_CREDENTIAL_SQL).get(tenantId, connector) as { ciphertext: string } | undefined
  if (!r || !r.ciphertext) return null // empty ciphertext = the secret-less enrich:fallback opt-in flag, never a key
  return decryptSecret(r.ciphertext, ctx(tenantId, connector), master)
}
export async function readEnabledCredential(db: Db, tenantId: string, connector: string, master?: Buffer): Promise<string | null> {
  const r = await db.get<{ ciphertext: string }>(ENABLED_CREDENTIAL_SQL, [tenantId, connector])
  if (!r || !r.ciphertext) return null // empty ciphertext = the secret-less enrich:fallback opt-in flag, never a key
  return decryptSecret(r.ciphertext, ctx(tenantId, connector), master)
}

export type AuditEntry = { tenantId: string; connector: string; jobId?: string | null; lookup: string; status: string; results: number }
const AUDIT_SQL = 'INSERT INTO connector_audit (id, tenant_id, connector, scan_job_id, lookup, status, results) VALUES (?, ?, ?, ?, ?, ?, ?)'
const auditArgs = (a: AuditEntry) => [randomBytes(12).toString('hex'), a.tenantId, a.connector, a.jobId ?? null, a.lookup.slice(0, 200), a.status, a.results]
export function audit(db: Database.Database, a: AuditEntry): void {
  db.prepare(AUDIT_SQL).run(...auditArgs(a))
}
// Paid-call credit discipline (#382): reserve the audit row BEFORE the provider call and settle it after, so a crash
// between the call and the write can never make a replay pay twice - the stale 'reserved' row is proof the call may
// have been charged, and the replay fails closed (skips, reports uncertain) instead of paying again.
export function auditReserved(db: Database.Database, a: AuditEntry): string {
  const id = randomBytes(12).toString('hex')
  db.prepare(AUDIT_SQL).run(id, a.tenantId, a.connector, a.jobId ?? null, a.lookup.slice(0, 200), 'reserved', 0)
  return id
}
export function auditSettle(db: Database.Database, id: string, status: string, results: number): void {
  db.prepare("UPDATE connector_audit SET status = ?, results = ? WHERE id = ? AND status = 'reserved'").run(status, results, id)
}
// The credit-discipline gate (#382): claim a lookup ATOMICALLY before paying for it. connector_claims' PRIMARY KEY
// is the race decider on BOTH engines (ON CONFLICT DO NOTHING; two PG connections on the same key: exactly one
// wins) - no reliance on job-claim leases or check-then-insert reads. A replayed job (stale-lease double-run,
// resume, or a concurrent caller on a lease-less route) loses the race and reads the winner's outcome instead of
// paying again. Terminal outcomes (ok/empty/rejected) keep the claim as the job's memo and replay free; a
// A TRANSIENT settle HOLDS the claim: the tenant's actual provider plan is not verifiable from here, and a plan
// that charges for errored requests would make ANY automatic release a rebill path - so no outcome without a
// terminal, data-returned answer ever frees the lookup. Recovery (per-step memo + owner resolution) is a tracked
// follow-up; until then a held lead replays fail-closed and surfaces as uncertain. A stale 'reserved' claim proves
// the pass MAY have been charged, so the replay fails CLOSED (uncertain, never a second payment). The claim key
// uses '' for a missing jobId because SQL NULL never equals NULL (callers always pass one today).
export type ReserveOutcome = { id: string } | { prior: 'ok' | 'empty' | 'rejected' | 'uncertain' }
const CLAIM_INSERT_SQL = "INSERT INTO connector_claims (tenant_id, connector, scan_job_id, lookup, status, claimed_at) VALUES (?, ?, ?, ?, 'reserved', ?) ON CONFLICT DO NOTHING"
const CLAIM_STATUS_SQL = "SELECT status FROM connector_claims WHERE tenant_id = ? AND connector = ? AND scan_job_id = ? AND lookup = ?"
const CLAIM_SETTLE_SQL = "UPDATE connector_claims SET status = ?, settled_at = ? WHERE tenant_id = ? AND connector = ? AND scan_job_id = ? AND lookup = ? AND status = 'reserved'"
// The memo lands in the SAME settle UPDATE as the terminal status: memo presence can never drift from the claim's
// outcome, and the status='reserved' guard makes a terminal memo immutable (no automatic rewrites, ever).
const CLAIM_SETTLE_MEMO_SQL = "UPDATE connector_claims SET status = ?, settled_at = ?, memo = ? WHERE tenant_id = ? AND connector = ? AND scan_job_id = ? AND lookup = ? AND status = 'reserved' AND memo IS NULL"
const RESERVE_STATUS_SQL = "SELECT status FROM connector_audit WHERE tenant_id = ? AND connector = ? AND scan_job_id = ? AND lookup = ? ORDER BY created_at DESC, insert_seq DESC LIMIT 1"
const claimKey = (a: AuditEntry) => [a.tenantId, a.connector, a.jobId ?? '', a.lookup.slice(0, 200)] as const
const isTerminal = (status: string) => status === 'ok' || status === 'empty' || status.startsWith('contact rejected')
const claimPrior = (status: string): 'ok' | 'empty' | 'rejected' | 'uncertain' =>
  status === 'ok' || status === 'empty' ? status : status === 'rejected' || status.startsWith('contact rejected') ? 'rejected' : 'uncertain'
export function auditTryReserve(db: Database.Database, a: AuditEntry): ReserveOutcome {
  const lookup = a.lookup.slice(0, 200)
  const key = claimKey(a)
  const now = Math.floor(Date.now() / 1000)
  const won = db.prepare(CLAIM_INSERT_SQL).run(key[0], key[1], key[2], key[3], now).changes === 1
  if (!won) {
    const r = db.prepare(CLAIM_STATUS_SQL).get(key[0], key[1], key[2], key[3]) as { status: string } | undefined
    return { prior: claimPrior(r?.status ?? 'reserved') }
  }
  // Stores written before claims existed can carry this lookup's audit rows: a crashed pass's 'reserved' or a
  // terminal outcome there is the same contract (every attempt since claims writes both).
  const legacy = db.prepare(RESERVE_STATUS_SQL).get(a.tenantId, a.connector, a.jobId ?? null, lookup) as { status: string } | undefined
  if (legacy && (isTerminal(legacy.status) || legacy.status === 'reserved')) {
    const prior = claimPrior(legacy.status)
    if (prior !== 'uncertain') db.prepare(CLAIM_SETTLE_SQL).run(prior, now, key[0], key[1], key[2], key[3])
    return { prior }
  }
  const id = randomBytes(12).toString('hex')
  db.prepare(AUDIT_SQL).run(id, a.tenantId, a.connector, a.jobId ?? null, lookup, 'reserved', 0)
  return { id }
}
// Settle a reserved lookup: the audit row and its claim move together in one transaction. Terminal outcomes mark
// the claim (the durable never-pay-twice memo); non-terminal outcomes hold it (no automatic release on an unverifiable plan).
export function auditSettleClaim(db: Database.Database, a: AuditEntry, id: string, status: string, results: number, memo?: string): void {
  const key = claimKey(a)
  db.transaction(() => {
    db.prepare("UPDATE connector_audit SET status = ?, results = ? WHERE id = ? AND status = 'reserved'").run(status, results, id)
    if (isTerminal(status)) {
      const claimStatus = status.startsWith('contact rejected') ? 'rejected' : status
      if (memo == null) db.prepare(CLAIM_SETTLE_SQL).run(claimStatus, Math.floor(Date.now() / 1000), key[0], key[1], key[2], key[3])
      else db.prepare(CLAIM_SETTLE_MEMO_SQL).run(claimStatus, Math.floor(Date.now() / 1000), memo, key[0], key[1], key[2], key[3])
    }
    // else: a non-terminal outcome HOLDS the claim 'reserved' - held for review, never automatically re-billed
  }).immediate()
}
// Async twins for the Postgres port: the SAME statements, exercised against PG by the two-connection race test.
export async function writeTryReserve(db: Db, a: AuditEntry): Promise<ReserveOutcome> {
  const lookup = a.lookup.slice(0, 200)
  const key = claimKey(a)
  const now = Math.floor(Date.now() / 1000)
  // One transaction, as on the sync path: the PK claim insert decides the race; the audit row is written with it.
  return db.tx(function* (t) {
    const won = ((yield* t.run(CLAIM_INSERT_SQL, [key[0], key[1], key[2], key[3], now]))).changes === 1
    if (!won) {
      const r = yield* t.get<{ status: string }>(CLAIM_STATUS_SQL, [key[0], key[1], key[2], key[3]])
      return { prior: claimPrior(r?.status ?? 'reserved') } as ReserveOutcome
    }
    const legacy = yield* t.get<{ status: string }>(RESERVE_STATUS_SQL, [a.tenantId, a.connector, a.jobId ?? null, lookup])
    if (legacy && (isTerminal(legacy.status) || legacy.status === 'reserved')) {
      const prior = claimPrior(legacy.status)
      if (prior !== 'uncertain') yield* t.run(CLAIM_SETTLE_SQL, [prior, now, key[0], key[1], key[2], key[3]])
      return { prior } as ReserveOutcome
    }
    const id = randomBytes(12).toString('hex')
    yield* t.run(AUDIT_SQL, [id, a.tenantId, a.connector, a.jobId ?? null, lookup, 'reserved', 0])
    return { id } as ReserveOutcome
  })
}
export async function writeSettleClaim(db: Db, a: AuditEntry, id: string, status: string, results: number, memo?: string): Promise<void> {
  const key = claimKey(a)
  // The claim transition and the audit-row settlement are ONE transaction (parity with the sync path): a crash can
  // never leave a settled audit row beside a live claim (or vice versa).
  await db.tx(function* (t) {
    if (isTerminal(status)) {
      const claimStatus = status.startsWith('contact rejected') ? 'rejected' : status
      if (memo == null) yield* t.run(CLAIM_SETTLE_SQL, [claimStatus, Math.floor(Date.now() / 1000), key[0], key[1], key[2], key[3]])
      else yield* t.run(CLAIM_SETTLE_MEMO_SQL, [claimStatus, Math.floor(Date.now() / 1000), memo, key[0], key[1], key[2], key[3]])
    }
    // else: a non-terminal outcome HOLDS the claim 'reserved' - held for review, never automatically re-billed
    yield* t.run("UPDATE connector_audit SET status = ?, results = ? WHERE id = ? AND status = 'reserved'", [status, results, id])
  })
}
export async function writeAudit(db: Db, a: AuditEntry): Promise<void> {
  await db.run(AUDIT_SQL, auditArgs(a))
}

// Read-only outcome for a lookup key: the claim row when one exists, else (for keys older than the claims table)
// the lookup's latest audit row - a pre-claims terminal outcome must still replay free, a pre-claims 'reserved'
// still fails closed. Never writes: recovery code paths honor legacy state without creating legacy claims.
export type ClaimOutcome = { prior: 'ok' | 'empty' | 'rejected' | 'uncertain'; status: string; memo: string | null }
const CLAIM_READ_SQL = 'SELECT status, memo FROM connector_claims WHERE tenant_id = ? AND connector = ? AND scan_job_id = ? AND lookup = ?'
export function readOutcome(db: Database.Database, a: { tenantId: string; connector: string; jobId?: string | null; lookup: string }, opts: { legacyAudit?: boolean } = {}): ClaimOutcome | null {
  const key = claimKey(a as AuditEntry)
  const r = db.prepare(CLAIM_READ_SQL).get(key[0], key[1], key[2], key[3]) as { status: string; memo: string | null } | undefined
  if (r) return { prior: claimPrior(r.status), status: r.status, memo: r.memo ?? null }
  if (opts.legacyAudit === false) return null
  const legacy = db.prepare(RESERVE_STATUS_SQL).get(a.tenantId, a.connector, a.jobId ?? null, a.lookup.slice(0, 200)) as { status: string } | undefined
  // Same guard as auditTryReserve's legacy path: only a terminal or still-reserved audit row is an outcome;
  // anything else (a transient code, a setup note) is observability, not a replay decision.
  if (!legacy || !(isTerminal(legacy.status) || legacy.status === 'reserved')) return null
  return { prior: claimPrior(legacy.status), status: legacy.status, memo: null }
}
export async function readOutcomeAsync(db: Db, a: { tenantId: string; connector: string; jobId?: string | null; lookup: string }, opts: { legacyAudit?: boolean } = {}): Promise<ClaimOutcome | null> {
  const key = claimKey(a as AuditEntry)
  const r = await db.get<{ status: string; memo: string | null }>(CLAIM_READ_SQL, [key[0], key[1], key[2], key[3]])
  if (r) return { prior: claimPrior(r.status), status: r.status, memo: r.memo ?? null }
  if (opts.legacyAudit === false) return null
  const legacy = await db.get<{ status: string }>(RESERVE_STATUS_SQL, [a.tenantId, a.connector, a.jobId ?? null, a.lookup.slice(0, 200)])
  if (!legacy || !(isTerminal(legacy.status) || legacy.status === 'reserved')) return null
  return { prior: claimPrior(legacy.status), status: legacy.status, memo: null }
}

// OWNER-EXPLICIT release of a held claim (the retry route's one write): never called by any automatic path. A
// 'reserved' claim NEVER carries a memo - memos are written only by the terminal settle, and the settle and the
// release both gate on status - so the guarded delete can touch only a crash remnant with no outcome attached;
// a settled memo (a paid org outcome, including a rejection verdict) is never released out from under its
// audit lineage. The release audit row names the released claim's claimed_at, keeping the lineage link from
// the original reservation through the owner's release to the next attempt's fresh claim row.
const CLAIM_READ_CLAIMED_AT_SQL = 'SELECT claimed_at FROM connector_claims WHERE tenant_id = ? AND connector = ? AND scan_job_id = ? AND lookup = ?'
const CLAIM_DELETE_HELD_SQL = "DELETE FROM connector_claims WHERE tenant_id = ? AND connector = ? AND scan_job_id = ? AND lookup = ? AND status = 'reserved'"
const releaseStatus = (claimedAt: number | undefined, disclosure: string) => `owner released held claim of ${new Date((claimedAt ?? 0) * 1000).toISOString()}: ${disclosure}`.slice(0, 200)
export function releaseHeldClaim(db: Database.Database, a: { tenantId: string; connector: string; jobId: string; lookup: string }, disclosure: string): boolean {
  const key = claimKey(a as AuditEntry)
  const row = db.prepare(CLAIM_READ_CLAIMED_AT_SQL).get(key[0], key[1], key[2], key[3]) as { claimed_at: number } | undefined
  const gone = db.prepare(CLAIM_DELETE_HELD_SQL).run(key[0], key[1], key[2], key[3]).changes === 1
  if (gone) audit(db, { tenantId: a.tenantId, connector: a.connector, jobId: a.jobId, lookup: a.lookup, status: releaseStatus(row?.claimed_at, disclosure), results: 0 })
  return gone
}
// PG twin: the same guarded delete + disclosure audit in one transaction (parity with the sync path above).
export async function releaseHeldClaimAsync(db: Db, a: { tenantId: string; connector: string; jobId: string; lookup: string }, disclosure: string): Promise<boolean> {
  const key = claimKey(a as AuditEntry)
  return db.tx(function* (t) {
    const row = yield* t.get<{ claimed_at: number }>(CLAIM_READ_CLAIMED_AT_SQL, [key[0], key[1], key[2], key[3]])
    const gone = ((yield* t.run(CLAIM_DELETE_HELD_SQL, [key[0], key[1], key[2], key[3]]))).changes === 1
    if (gone) yield* t.run(AUDIT_SQL, auditArgs({ tenantId: a.tenantId, connector: a.connector, jobId: a.jobId, lookup: a.lookup, status: releaseStatus(row?.claimed_at, disclosure), results: 0 }))
    return gone
  })
}
// The lookup's latest audit status (read-only): replay repair reads the recorded verdict behind a terminal claim.
export function latestAuditStatus(db: Database.Database, a: { tenantId: string; connector: string; jobId: string; lookup: string }): string | null {
  const r = db.prepare(RESERVE_STATUS_SQL).get(a.tenantId, a.connector, a.jobId, a.lookup.slice(0, 200)) as { status: string } | undefined
  return r?.status ?? null
}

// Newest first; same-second rows newest-inserted first (insert_seq: the order rowid gave). Sync for the pipeline's
// tests and tools on the raw handle; readRecentAudit for the settings routes.
const RECENT_AUDIT_SQL = "SELECT connector, scan_job_id, lookup, status, results, created_at FROM connector_audit WHERE tenant_id = ? AND connector NOT LIKE 'check:%' ORDER BY created_at DESC, insert_seq DESC LIMIT ?" // 'check:%' rows (per-lead board-check history, #533) would flood the settings status list and displace real connector audits; they stay DB/support-readable, never displayed here
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
