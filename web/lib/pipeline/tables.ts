// SQLite DDL for the revenue pipeline (#366, lib/pipeline/deals.ts). PG: lib/db/migrations/pg/0048_revenue_pipeline.sql.
//   deals                - one canonical deal per qualified conversation (UNIQUE tenant, thread), its current state
//   deal_stage_events    - append-only history: one full snapshot per change (UPDATE refused), so any past state of a
//                          deal is the latest event at or before that time
//   deal_routing_rules   - ordered rules that pick the owner (a workspace member) of a newly routed deal
// Every table carries tenant_id, so tenant export/deletion and the deleted-tenant guards cover it (lib/tenant/scope.ts).
import type Database from 'better-sqlite3'

export function migratePipeline(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS deals (
      id           TEXT PRIMARY KEY,
      tenant_id    TEXT NOT NULL,
      thread_id    TEXT NOT NULL CHECK (length(thread_id) <= 200),
      lead_id      TEXT NOT NULL,
      title        TEXT NOT NULL CHECK (length(title) <= 200),
      owner_id     TEXT,
      stage        TEXT NOT NULL CHECK (stage IN ('new', 'qualified', 'meeting', 'proposal', 'negotiation', 'won', 'lost')),
      amount_minor INTEGER CHECK (amount_minor IS NULL OR amount_minor >= 0),
      currency     TEXT CHECK (currency IS NULL OR length(currency) = 3),
      close_date   TEXT CHECK (close_date IS NULL OR length(close_date) = 10),
      close_reason TEXT CHECK (close_reason IS NULL OR length(close_reason) <= 40),
      close_note   TEXT CHECK (close_note IS NULL OR length(close_note) <= 200),
      rule_id      TEXT,
      route_reason TEXT NOT NULL CHECK (length(route_reason) <= 40),
      sla_due_at   INTEGER,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      closed_at    INTEGER,
      version      INTEGER NOT NULL CHECK (version >= 1),
      UNIQUE (tenant_id, thread_id)
    );
    CREATE INDEX IF NOT EXISTS deals_tenant_stage ON deals (tenant_id, stage);
    CREATE TABLE IF NOT EXISTS deal_stage_events (
      id           TEXT PRIMARY KEY,
      tenant_id    TEXT NOT NULL,
      deal_id      TEXT NOT NULL,
      seq          INTEGER NOT NULL CHECK (seq >= 1),
      kind         TEXT NOT NULL CHECK (kind IN ('created', 'changed', 'closed', 'reopened')),
      from_stage   TEXT CHECK (from_stage IS NULL OR length(from_stage) <= 20),
      stage        TEXT NOT NULL CHECK (stage IN ('new', 'qualified', 'meeting', 'proposal', 'negotiation', 'won', 'lost')),
      owner_id     TEXT,
      amount_minor INTEGER CHECK (amount_minor IS NULL OR amount_minor >= 0),
      currency     TEXT CHECK (currency IS NULL OR length(currency) = 3),
      close_reason TEXT CHECK (close_reason IS NULL OR length(close_reason) <= 40),
      actor_id     TEXT NOT NULL CHECK (length(actor_id) <= 80),
      at           INTEGER NOT NULL,
      UNIQUE (tenant_id, deal_id, seq)
    );
    CREATE INDEX IF NOT EXISTS deal_stage_events_tenant_at ON deal_stage_events (tenant_id, at);
    CREATE TRIGGER IF NOT EXISTS deal_stage_events_no_update BEFORE UPDATE ON deal_stage_events BEGIN SELECT RAISE(ABORT, 'deal history is append-only'); END;
    CREATE TABLE IF NOT EXISTS deal_routing_rules (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL,
      position    INTEGER NOT NULL CHECK (position >= 1),
      match_kind  TEXT NOT NULL CHECK (match_kind IN ('any', 'play', 'domain')),
      match_value TEXT NOT NULL CHECK (length(match_value) <= 200),
      owner_id    TEXT NOT NULL,
      sla_hours   INTEGER CHECK (sla_hours IS NULL OR (sla_hours >= 1 AND sla_hours <= 720)),
      active      INTEGER NOT NULL CHECK (active IN (1, 0)),
      created_by  TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS deal_routing_rules_tenant ON deal_routing_rules (tenant_id, active, position);
  `)
}
