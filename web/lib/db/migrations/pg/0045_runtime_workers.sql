-- Runtime workers (lib/workers/store.ts, docs/design/runtime-workers.md; refs #355). The reviewed worker catalog
-- (immutable rows), one deployment row per worker (version, state, fencing generation, global and per-tenant limits),
-- an append-only lifecycle trail, the per-tenant allowlist, and each tenant's runs. Generated translation of the SQLite
-- DDL (WORKERS_DDL); tomb guards per 0039 on the two tenant-scoped tables.
CREATE TABLE worker_catalog (
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    code_hash TEXT NOT NULL CHECK (char_length(code_hash) = 64),
    effect TEXT NOT NULL CHECK (effect IN ('none', 'draft', 'send', 'spend')),
    state_version BIGINT NOT NULL,
    definition TEXT NOT NULL CHECK (char_length(definition) <= 65536),
    registered_by TEXT NOT NULL CHECK (char_length(registered_by) <= 80),
    registered_at BIGINT NOT NULL,
    PRIMARY KEY (name, version)
  );

CREATE TABLE worker_deployments (
    name TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('running', 'draining', 'stopped', 'failed')),
    generation BIGINT NOT NULL,
    max_in_flight BIGINT NOT NULL,
    per_tenant_in_flight BIGINT NOT NULL,
    max_backlog BIGINT NOT NULL,
    max_attempts BIGINT NOT NULL,
    drain_deadline BIGINT,
    failures BIGINT NOT NULL DEFAULT 0,
    restarts BIGINT NOT NULL DEFAULT 0,
    restart_after BIGINT,
    reason TEXT CHECK (reason IS NULL OR char_length(reason) <= 200),
    updated_at BIGINT NOT NULL,
    updated_by TEXT NOT NULL CHECK (char_length(updated_by) <= 80)
  );

CREATE TABLE worker_events (
    id TEXT PRIMARY KEY,
    at BIGINT NOT NULL,
    actor TEXT NOT NULL CHECK (char_length(actor) <= 80),
    action TEXT NOT NULL CHECK (char_length(action) <= 40),
    decision TEXT NOT NULL CHECK (decision IN ('allowed', 'denied')),
    name TEXT CHECK (name IS NULL OR char_length(name) <= 40),
    version TEXT CHECK (version IS NULL OR char_length(version) <= 20),
    code_hash TEXT CHECK (code_hash IS NULL OR char_length(code_hash) = 64),
    generation BIGINT,
    detail TEXT CHECK (detail IS NULL OR char_length(detail) <= 200)
  );

CREATE TABLE worker_grants (
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    granted_by TEXT NOT NULL CHECK (char_length(granted_by) <= 80),
    granted_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, name)
  );

CREATE TABLE worker_runs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    actor_id TEXT NOT NULL CHECK (char_length(actor_id) <= 80),
    status TEXT NOT NULL CHECK (status IN ('queued', 'done', 'failed', 'refused')),
    input TEXT NOT NULL CHECK (char_length(input) <= 65536),
    version TEXT,
    generation BIGINT,
    output TEXT CHECK (output IS NULL OR char_length(output) <= 65536),
    error TEXT CHECK (error IS NULL OR char_length(error) <= 200),
    created_at BIGINT NOT NULL,
    finished_at BIGINT
  );

CREATE INDEX worker_events_at ON worker_events (at);

CREATE INDEX worker_runs_tenant ON worker_runs (tenant_id, created_at);

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_worker_grants() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_worker_grants ON worker_grants;
CREATE TRIGGER tomb_upd_worker_grants BEFORE UPDATE OF tenant_id ON worker_grants FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_worker_grants();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_worker_runs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_worker_runs ON worker_runs;
CREATE TRIGGER tomb_upd_worker_runs BEFORE UPDATE OF tenant_id ON worker_runs FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_worker_runs();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_worker_grants() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_worker_grants ON worker_grants;
CREATE TRIGGER tomb_worker_grants BEFORE INSERT ON worker_grants FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_worker_grants();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_worker_runs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_worker_runs ON worker_runs;
CREATE TRIGGER tomb_worker_runs BEFORE INSERT ON worker_runs FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_worker_runs();

CREATE OR REPLACE FUNCTION dazl_guard_worker_catalog_no_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TRUE) THEN RAISE EXCEPTION 'worker catalog entries are immutable'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS worker_catalog_no_update ON worker_catalog;
CREATE TRIGGER worker_catalog_no_update BEFORE UPDATE ON worker_catalog FOR EACH ROW EXECUTE FUNCTION dazl_guard_worker_catalog_no_update();

CREATE OR REPLACE FUNCTION dazl_guard_worker_events_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TRUE) THEN RAISE EXCEPTION 'worker events are append-only'; END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS worker_events_no_delete ON worker_events;
CREATE TRIGGER worker_events_no_delete BEFORE DELETE ON worker_events FOR EACH ROW EXECUTE FUNCTION dazl_guard_worker_events_no_delete();

CREATE OR REPLACE FUNCTION dazl_guard_worker_events_no_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TRUE) THEN RAISE EXCEPTION 'worker events are append-only'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS worker_events_no_update ON worker_events;
CREATE TRIGGER worker_events_no_update BEFORE UPDATE ON worker_events FOR EACH ROW EXECUTE FUNCTION dazl_guard_worker_events_no_update();
