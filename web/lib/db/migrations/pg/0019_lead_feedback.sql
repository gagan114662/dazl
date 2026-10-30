-- Reasoned accept/reject feedback (lib/scan/feedback.ts, #385): tenant-scoped, versioned, reversible (reverted_at keeps the row).
CREATE TABLE lead_feedback (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    entity_kind TEXT NOT NULL CHECK (entity_kind IN ('account','person','event')),
    entity_key TEXT NOT NULL,
    account_key TEXT NOT NULL,
    polarity TEXT NOT NULL CHECK (polarity IN ('reject','accept')),
    reason TEXT,
    origin TEXT NOT NULL DEFAULT 'explicit' CHECK (origin IN ('explicit','passive_optout','reply_positive')),
    source TEXT,
    query_key TEXT,
    event_key TEXT,
    note TEXT,
    version BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    reverted_at BIGINT
  );
CREATE INDEX idx_lead_feedback_tenant ON lead_feedback (tenant_id, entity_kind, entity_key);
