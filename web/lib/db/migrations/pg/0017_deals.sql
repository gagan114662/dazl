-- Deals (lib/pipeline/deals.ts, #366): a qualified conversation becomes a deal with an owner, audited stages, and a won
-- (amount + currency) or lost (reason) close. deal_stage_events keeps every change; one open deal per lead.
CREATE TABLE deal_stage_events (
  tenant_id  TEXT NOT NULL,
  deal_id    TEXT NOT NULL,
  seq        BIGINT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('created', 'moved', 'owner', 'reopened')),
  from_stage TEXT,
  to_stage   TEXT,
  owner_id   TEXT,
  actor      TEXT NOT NULL,
  detail     TEXT,
  at         BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, deal_id, seq)
);

CREATE TABLE deals (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  lead_id       TEXT NOT NULL,
  owner_id      TEXT NOT NULL,
  stage         TEXT NOT NULL CHECK (stage IN ('qualified', 'meeting', 'proposal', 'negotiation', 'won', 'lost')),
  amount_minor  BIGINT CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency      TEXT CHECK (currency IS NULL OR char_length(currency) = 3),
  close_date    TEXT,
  close_reason  TEXT CHECK (close_reason IS NULL OR char_length(close_reason) <= 300),
  version       BIGINT NOT NULL DEFAULT 1,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL
);

CREATE UNIQUE INDEX deals_one_open_per_lead ON deals (tenant_id, lead_id) WHERE stage NOT IN ('won', 'lost');
CREATE INDEX deals_tenant ON deals (tenant_id, stage);
