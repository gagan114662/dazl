-- Continuous event detection for monitors (#387, lib/monitor-events.ts): the per-monitor alert policy, how many
-- scheduled runs a late run stood in for, the tenant's event state (first seen / occurred / last checked / actionable /
-- reachable), the alert log with detection latency, and per-source cursors. Numbered 0046: #385's 0044_lead_feedback and #623's 0045_runtime_workers landed first.
ALTER TABLE monitors ADD COLUMN alert_policy TEXT NOT NULL DEFAULT 'all' CHECK (alert_policy IN ('all','reachable','new_companies'));

ALTER TABLE monitor_runs ADD COLUMN missed_runs BIGINT NOT NULL DEFAULT 0;

CREATE TABLE monitor_events (
      user_id         TEXT NOT NULL,
      event_key       TEXT NOT NULL,
      entity_key      TEXT NOT NULL,
      monitor_id      TEXT NOT NULL,
      occurred_at     BIGINT NOT NULL,
      first_seen_at   BIGINT NOT NULL,
      last_checked_at BIGINT NOT NULL,
      actionable_at   BIGINT,
      reachable_at    BIGINT,
      PRIMARY KEY (user_id, event_key)
    );

CREATE TABLE monitor_alerts (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      run_id     TEXT NOT NULL,
      event_key  TEXT NOT NULL,
      kind       TEXT NOT NULL CHECK (kind IN ('new_company','new_signal','now_reachable')),
      company    TEXT NOT NULL,
      latency_s  BIGINT NOT NULL,
      at         BIGINT NOT NULL
    );

CREATE TABLE monitor_cursors (
      monitor_id      TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      source          TEXT NOT NULL,
      last_event_at   BIGINT,
      last_checked_at BIGINT NOT NULL,
      PRIMARY KEY (monitor_id, source)
    );

CREATE INDEX monitor_events_entity ON monitor_events (user_id, entity_key);
CREATE INDEX monitor_alerts_monitor ON monitor_alerts (monitor_id, at);

-- Tenant-deletion guards over the three new tables (same generated shape as 0042/0043): a tombstoned tenant, or a
-- deleted monitor, can neither gain nor keep event state, alerts or cursors.

CREATE OR REPLACE FUNCTION dazl_guard_tomb_monitor_events() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.user_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.user_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_monitor_events ON monitor_events;
CREATE TRIGGER tomb_monitor_events BEFORE INSERT ON monitor_events FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_monitor_events();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_monitor_alerts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.user_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.user_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_monitor_alerts ON monitor_alerts;
CREATE TRIGGER tomb_monitor_alerts BEFORE INSERT ON monitor_alerts FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_monitor_alerts();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_monitor_cursors() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext((SELECT user_id FROM monitors WHERE id = NEW.monitor_id)));
  IF (EXISTS (SELECT 1 FROM tenant_tombstone_keys WHERE tbl = 'monitors' AND key = NEW.monitor_id) OR EXISTS (SELECT 1 FROM monitors p0 JOIN tenant_tombstones t0 ON t0.deleted_tenant = p0.user_id WHERE p0.id = NEW.monitor_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_monitor_cursors ON monitor_cursors;
CREATE TRIGGER tomb_monitor_cursors BEFORE INSERT ON monitor_cursors FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_monitor_cursors();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_monitor_events() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.user_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.user_id));
  IF (NEW.user_id IS DISTINCT FROM OLD.user_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.user_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.user_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_monitor_events ON monitor_events;
CREATE TRIGGER tomb_upd_monitor_events BEFORE UPDATE OF user_id ON monitor_events FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_monitor_events();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_monitor_alerts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.user_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.user_id));
  IF (NEW.user_id IS DISTINCT FROM OLD.user_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.user_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.user_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_monitor_alerts ON monitor_alerts;
CREATE TRIGGER tomb_upd_monitor_alerts BEFORE UPDATE OF user_id ON monitor_alerts FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_monitor_alerts();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_monitor_cursors() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext((SELECT user_id FROM monitors WHERE id = NEW.monitor_id)));
  PERFORM pg_advisory_xact_lock_shared(hashtext((SELECT user_id FROM monitors WHERE id = OLD.monitor_id)));
  IF (NEW.monitor_id IS DISTINCT FROM OLD.monitor_id AND ((EXISTS (SELECT 1 FROM tenant_tombstone_keys WHERE tbl = 'monitors' AND key = NEW.monitor_id) OR EXISTS (SELECT 1 FROM monitors p0 JOIN tenant_tombstones t0 ON t0.deleted_tenant = p0.user_id WHERE p0.id = NEW.monitor_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstone_keys WHERE tbl = 'monitors' AND key = OLD.monitor_id) OR EXISTS (SELECT 1 FROM monitors p0 JOIN tenant_tombstones t0 ON t0.deleted_tenant = p0.user_id WHERE p0.id = OLD.monitor_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_monitor_cursors ON monitor_cursors;
CREATE TRIGGER tomb_upd_monitor_cursors BEFORE UPDATE OF monitor_id ON monitor_cursors FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_monitor_cursors();
