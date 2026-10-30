-- Scoped external API tokens, idempotent submissions and per-token rate windows (lib/api-access/scoped.ts, #392).
CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    scopes TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    expires_at BIGINT,
    revoked_at BIGINT,
    last_used_at BIGINT
  );
CREATE INDEX api_tokens_tenant ON api_tokens (tenant_id);
CREATE TABLE api_idempotency (
    tenant_id TEXT NOT NULL,
    idem_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    job_id TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, idem_key)
  );
CREATE TABLE api_rate (
    token_id TEXT NOT NULL,
    window_start BIGINT NOT NULL,
    n BIGINT NOT NULL,
    PRIMARY KEY (token_id, window_start)
  );
