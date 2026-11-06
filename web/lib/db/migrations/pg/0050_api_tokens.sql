-- Scoped workspace API tokens and idempotent API scan starts (#392, lib/api-tokens.ts). api_tokens keeps only the
-- SHA-256 of each secret (token_hash) and a public id; it is a credential table (deleted at the 'revoked' step of a
-- tenant deletion, lib/tenant/lifecycle.ts CREDENTIAL_TABLES). api_token_scans claims (token, idempotency key) before
-- an API scan starts, so a retried request returns the first scan instead of starting another.
CREATE TABLE api_token_scans (
      tenant_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      idem_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      scan_job_id TEXT,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (token_id, idem_key)
    );

CREATE TABLE api_tokens (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      label TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      scopes TEXT NOT NULL,
      scans_per_day BIGINT NOT NULL DEFAULT 0,
      max_usd_per_scan DOUBLE PRECISION NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL,
      last_used_at BIGINT,
      revoked_at BIGINT,
      revoked_by TEXT
    );

CREATE INDEX api_token_scans_tenant ON api_token_scans (tenant_id);

CREATE INDEX api_tokens_tenant ON api_tokens (tenant_id);

-- Tenant-lifecycle guards for both tables, the verbatim translation of the generated SQLite guard DDL (same pipeline as
-- 0039-0043): a tombstoned tenant gains no rows, and no row moves into or out of a tombstoned tenant.

CREATE OR REPLACE FUNCTION dazl_guard_tomb_api_token_scans() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_api_token_scans ON api_token_scans;
CREATE TRIGGER tomb_api_token_scans BEFORE INSERT ON api_token_scans FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_api_token_scans();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_api_tokens() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_api_tokens ON api_tokens;
CREATE TRIGGER tomb_api_tokens BEFORE INSERT ON api_tokens FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_api_tokens();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_api_token_scans() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_api_token_scans ON api_token_scans;
CREATE TRIGGER tomb_upd_api_token_scans BEFORE UPDATE OF tenant_id ON api_token_scans FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_api_token_scans();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_api_tokens() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_api_tokens ON api_tokens;
CREATE TRIGGER tomb_upd_api_tokens BEFORE UPDATE OF tenant_id ON api_tokens FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_api_tokens();
