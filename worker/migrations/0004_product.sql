-- Product layer: plans/usage metering, ICP + leads + outreach drafts
-- (Gojiberry-style outbound), creative variants (Gooseworks-style), and
-- email compliance state. Additive only.

-- Plan + sender identity. postal_address and sender_name are REQUIRED before
-- any outbound email can be sent (CAN-SPAM identity requirements).
ALTER TABLE tenants ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE tenants ADD COLUMN sender_name TEXT;
ALTER TABLE tenants ADD COLUMN postal_address TEXT;
ALTER TABLE tenants ADD COLUMN stripe_customer_id TEXT;

-- Append-only usage ledger; quotas are computed from it per calendar month.
CREATE TABLE IF NOT EXISTS usage_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  units      INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_usage_tenant_kind_time ON usage_events (tenant_id, kind, created_at);

-- One ideal-customer-profile per tenant.
CREATE TABLE IF NOT EXISTS icps (
  tenant_id   TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  offer       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS leads (
  lead_id      TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,
  company      TEXT,
  title        TEXT,
  signal       TEXT,
  score        INTEGER,
  score_reason TEXT,
  status       TEXT NOT NULL DEFAULT 'new',
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (tenant_id, email)
);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_score ON leads (tenant_id, score);

-- Outreach drafts are NEVER sent without explicit approval.
-- status: draft -> approved -> sending -> sent | failed ; draft -> rejected
CREATE TABLE IF NOT EXISTS outreach_drafts (
  draft_id   TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  lead_id    TEXT NOT NULL,
  channel    TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'draft',
  error      TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  sent_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_drafts_tenant_status ON outreach_drafts (tenant_id, status);

-- Per-tenant do-not-contact list (unsubscribes, manual suppressions).
CREATE TABLE IF NOT EXISTS suppressions (
  tenant_id  TEXT NOT NULL,
  email      TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS creatives (
  creative_id TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  channel     TEXT NOT NULL,
  brief       TEXT NOT NULL,
  variants    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft',
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_creatives_tenant ON creatives (tenant_id, created_at);

-- The pre-multitenancy default tenant is the operator's own workload; do not
-- subject it to free-plan caps.
UPDATE tenants SET plan = 'pro' WHERE tenant_id = 'default';
