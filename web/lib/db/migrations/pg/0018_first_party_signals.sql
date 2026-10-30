-- Consent-aware first-party demand signals (lib/signals/first-party.ts, #390).
CREATE TABLE fp_settings (
    tenant_id TEXT PRIMARY KEY,
    collection_enabled BIGINT NOT NULL DEFAULT 0,
    visitor_enabled BIGINT NOT NULL DEFAULT 0,
    retention_days BIGINT NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 1 AND 730),
    updated_at BIGINT NOT NULL
  );
CREATE TABLE fp_domains (
    tenant_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    PRIMARY KEY (tenant_id, domain)
  );
CREATE TABLE fp_nonces (
    tenant_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    seen_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, nonce)
  );
CREATE TABLE fp_events (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('form','demo_request','product_event','visitor')),
    account_key TEXT NOT NULL,
    company TEXT,
    person_email TEXT,
    identity_confidence BIGINT NOT NULL CHECK (identity_confidence BETWEEN 0 AND 100),
    level TEXT NOT NULL CHECK (level IN ('person','account')),
    occurred_at BIGINT NOT NULL,
    received_at BIGINT NOT NULL,
    dedup_key TEXT NOT NULL,
    UNIQUE (tenant_id, dedup_key)
  );
CREATE INDEX fp_events_tenant ON fp_events (tenant_id, occurred_at);
