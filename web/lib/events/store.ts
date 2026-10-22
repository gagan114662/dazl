import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'

// Company event store: the tenant-isolated foundation for account-level signal history.
// Every row is one observed company-level event (funding round, hiring surge, ...) with
// mandatory provenance (source URL + retrieval time) and a natural dedup key, so the
// same fact reported by the same source twice refreshes last_seen instead of duplicating.
// Unknowns stay NULL - a missing published date or person is never guessed.
// Company-level events only: no person rows, no visitor rows, no cross-tenant pooling.

export const EVENT_TYPES = ['funding_round', 'hiring_surge', 'tech_stack', 'competitor_mention'] as const
export type EventType = (typeof EVENT_TYPES)[number]
export type EventScope = 'account' | 'market'

// How long an event type stays "fresh" for ranking. Freshness is derived at read time,
// never stored, so a policy change does not require rewriting rows.
// These windows are PRODUCT HEURISTICS chosen for ranking convenience - they are not
// verified external truth about how long any signal actually predicts anything.
export const FRESHNESS_DAYS: Record<EventType, number> = {
  funding_round: 548, // a filed round stays relevant ~18 months
  hiring_surge: 30,
  tech_stack: 90,
  competitor_mention: 30,
}

export function migrateEvents(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS company_events (
      id                 TEXT PRIMARY KEY,
      tenant_id          TEXT NOT NULL,
      company_key        TEXT NOT NULL CHECK (length(company_key) <= 254),
      company_name       TEXT CHECK (company_name IS NULL OR length(company_name) <= 200),
      scope              TEXT NOT NULL CHECK (scope IN ('account','market')),
      lead_id            TEXT,
      event_type         TEXT NOT NULL,
      summary            TEXT NOT NULL CHECK (length(summary) <= 300),
      detail             TEXT,
      source_url         TEXT NOT NULL CHECK (length(source_url) <= 500 AND source_url LIKE 'http%'),
      source_published_at TEXT CHECK (source_published_at IS NULL OR length(source_published_at) = 10),
      retrieved_at       INTEGER NOT NULL,
      first_seen_at      INTEGER NOT NULL,
      last_seen_at       INTEGER NOT NULL,
      confidence         INTEGER,
      UNIQUE (tenant_id, company_key, event_type, source_url)
    );
    CREATE INDEX IF NOT EXISTS company_events_tenant ON company_events (tenant_id, last_seen_at);
    CREATE INDEX IF NOT EXISTS company_events_company ON company_events (tenant_id, company_key);
  `)
}

// Identity rule: a history may only aggregate facts about ONE entity.
// - Domain known: the domain is the key. Domains are unique, so aggregation is safe.
// - Domain unknown: the key is the tenant's own account record ("lead:<leadId>"). Events
//   aggregate within that record only - two different companies that happen to share a
//   name ("Acme Corp" in two cities) are different leads, get different keys, and never
//   merge into one false history. The normalized name is display metadata, not identity.
// - Neither known: the event is not recorded. Unresolved entity identity is preserved,
//   never merged by name.
// When a lead later gains a domain, future events key by the domain; the older
// lead-keyed history is not auto-merged (explicit reconciliation is a future decision).
export function companyKey(domain: string | null | undefined, leadId: string | null | undefined): string | null {
  const d = (domain ?? '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].trim()
  if (d.includes('.')) return d.slice(0, 250)
  const id = (leadId ?? '').trim()
  return id ? `lead:${id}`.slice(0, 254) : null
}

export interface CompanyEventInput {
  companyKey: string
  companyName?: string | null
  scope: EventScope
  leadId?: string | null
  eventType: EventType
  summary: string
  detail?: string | null
  sourceUrl: string
  sourcePublishedAt?: string | null // YYYY-MM-DD when the source itself states a date
  retrievedAt: number
  confidence?: number | null
}

// Insert a new event, or refresh last_seen_at (and a newer published date) when the same
// tenant/company/type/source fact is observed again. Returns true when a row was created.
export function recordCompanyEvent(db: Database.Database, tenantId: string, e: CompanyEventInput): boolean {
  if (!EVENT_TYPES.includes(e.eventType)) throw new Error(`unknown event type: ${e.eventType}`)
  const existing = db.prepare('SELECT id FROM company_events WHERE tenant_id = ? AND company_key = ? AND event_type = ? AND source_url = ?')
    .get(tenantId, e.companyKey, e.eventType, e.sourceUrl)
  db.prepare(
    `INSERT INTO company_events (id, tenant_id, company_key, company_name, scope, lead_id, event_type, summary, detail, source_url, source_published_at, retrieved_at, first_seen_at, last_seen_at, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, company_key, event_type, source_url)
     DO UPDATE SET last_seen_at = excluded.last_seen_at,
                   retrieved_at = excluded.retrieved_at,
                   source_published_at = COALESCE(company_events.source_published_at, excluded.source_published_at),
                   summary = CASE WHEN excluded.retrieved_at >= company_events.retrieved_at THEN excluded.summary ELSE company_events.summary END`,
  ).run(randomBytes(12).toString('hex'), tenantId, e.companyKey, e.companyName ?? null, e.scope, e.leadId ?? null,
    e.eventType, e.summary.slice(0, 300), e.detail ?? null, e.sourceUrl, e.sourcePublishedAt ?? null,
    e.retrievedAt, e.retrievedAt, e.retrievedAt, e.confidence ?? null)
  return !existing
}

export interface CompanyEventRow {
  id: string; company_key: string; company_name: string | null; scope: EventScope; lead_id: string | null
  event_type: EventType; summary: string; detail: string | null; source_url: string
  source_published_at: string | null; retrieved_at: number; first_seen_at: number; last_seen_at: number
  confidence: number | null; fresh: boolean
}

// Tenant-scoped reads only. freshOnly filters by the per-type freshness window at read time.
export function listCompanyEvents(db: Database.Database, tenantId: string, opts: { companyKey?: string; scope?: EventScope; freshOnly?: boolean; now?: number; limit?: number } = {}): CompanyEventRow[] {
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const rows = db.prepare(
    `SELECT id, company_key, company_name, scope, lead_id, event_type, summary, detail, source_url, source_published_at, retrieved_at, first_seen_at, last_seen_at, confidence
     FROM company_events WHERE tenant_id = ?
       AND (? IS NULL OR company_key = ?) AND (? IS NULL OR scope = ?)
     ORDER BY last_seen_at DESC LIMIT ?`,
  ).all(tenantId, opts.companyKey ?? null, opts.companyKey ?? null, opts.scope ?? null, opts.scope ?? null, opts.limit ?? 200) as Omit<CompanyEventRow, 'fresh'>[]
  return rows
    .map(r => ({ ...r, fresh: r.last_seen_at >= now - FRESHNESS_DAYS[r.event_type] * 86400 }))
    .filter(r => !opts.freshOnly || r.fresh)
}
