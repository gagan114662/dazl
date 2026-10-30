-- Scoped per-workspace API keys and idempotent discovery starts for the external discovery API (lib/api/keys.ts, #392).
-- key_hash is the SHA-256 of the key; the key itself is never stored.
CREATE TABLE api_keys (
    id TEXT PRIMARY KEY CHECK (char_length(id) = 16), tenant_id TEXT NOT NULL, created_by TEXT NOT NULL,
    name TEXT NOT NULL CHECK (char_length(name) <= 80), key_hash TEXT NOT NULL UNIQUE CHECK (char_length(key_hash) = 64),
    scopes TEXT NOT NULL CHECK (char_length(scopes) <= 200), created_at BIGINT NOT NULL, revoked_at BIGINT, last_used_at BIGINT
  );
CREATE INDEX api_keys_tenant ON api_keys (tenant_id);
CREATE TABLE api_idempotency (
    tenant_id TEXT NOT NULL, idem_key TEXT NOT NULL CHECK (char_length(idem_key) <= 128),
    request_hash TEXT NOT NULL CHECK (char_length(request_hash) = 64), job_id TEXT, created_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, idem_key)
  );
