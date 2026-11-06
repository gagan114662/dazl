-- #399 slice 1: experiment runner (lib/autopilot/experiment-runner.ts). Staging stub only: experiments (draft ->
-- running -> paused/stopped; "running" = arm claims allowed in the staging stub, never a live launch), one arm claim per
-- (tenant, experiment, prospect), and an append-only record of every call and its outcome. All three tables are
-- tenant-scoped (tenant_id) and tomb-guarded per 0039.
-- Numbered 0050: main's highest is 0049_first_party_withdrawals at the 2026-11-06 merge of main. Whichever queued PR lands later
-- renumbers to main's then-highest + 1 (#619's revenue pipeline also carries a 0050 on its branch).
CREATE TABLE experiment_arm_claims (
      tenant_id     TEXT NOT NULL,
      experiment_id TEXT NOT NULL,
      prospect_key  TEXT NOT NULL,
      arm           TEXT NOT NULL,
      claimed_at    BIGINT NOT NULL,
      PRIMARY KEY (tenant_id, experiment_id, prospect_key)
    );

CREATE TABLE experiment_events (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL,
      experiment_id TEXT NOT NULL,
      action        TEXT NOT NULL CHECK (action IN ('create','start','pause','stop','claim')),
      outcome       TEXT NOT NULL CHECK (outcome IN ('ok','noop','refused','already_claimed')),
      reason        TEXT,
      prospect_key  TEXT,
      arm           TEXT,
      created_at    BIGINT NOT NULL
    );

CREATE TABLE experiments (
      tenant_id      TEXT NOT NULL,
      id             TEXT NOT NULL,
      config_json    TEXT NOT NULL,
      status         TEXT NOT NULL CHECK (status IN ('draft','running','paused','stopped')),
      volume_cap     BIGINT NOT NULL CHECK (volume_cap > 0),
      claimed_count  BIGINT NOT NULL DEFAULT 0 CHECK (claimed_count >= 0 AND claimed_count <= volume_cap),
      claim_attempts BIGINT NOT NULL DEFAULT 0,
      created_at     BIGINT NOT NULL,
      started_at     BIGINT,
      paused_at      BIGINT,
      stopped_at     BIGINT,
      PRIMARY KEY (tenant_id, id)
    );

CREATE INDEX experiment_events_exp ON experiment_events (tenant_id, experiment_id, created_at);

CREATE OR REPLACE FUNCTION dazl_guard_tomb_experiment_arm_claims() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_experiment_arm_claims ON experiment_arm_claims;
CREATE TRIGGER tomb_experiment_arm_claims BEFORE INSERT ON experiment_arm_claims FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_experiment_arm_claims();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_experiment_events() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_experiment_events ON experiment_events;
CREATE TRIGGER tomb_experiment_events BEFORE INSERT ON experiment_events FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_experiment_events();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_experiments() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_experiments ON experiments;
CREATE TRIGGER tomb_experiments BEFORE INSERT ON experiments FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_experiments();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_experiment_arm_claims() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_experiment_arm_claims ON experiment_arm_claims;
CREATE TRIGGER tomb_upd_experiment_arm_claims BEFORE UPDATE OF tenant_id ON experiment_arm_claims FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_experiment_arm_claims();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_experiment_events() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_experiment_events ON experiment_events;
CREATE TRIGGER tomb_upd_experiment_events BEFORE UPDATE OF tenant_id ON experiment_events FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_experiment_events();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_experiments() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_experiments ON experiments;
CREATE TRIGGER tomb_upd_experiments BEFORE UPDATE OF tenant_id ON experiments FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_experiments();
