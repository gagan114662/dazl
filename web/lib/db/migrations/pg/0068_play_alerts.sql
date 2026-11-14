-- #883 alert once across plays (lib/play-alerts.ts): the tenant's record of "this company was already alerted", one row
-- per (tenant, company key: its domain and its name), naming the play and run that alerted it first. Not tied to the play's row (deleting a play
-- keeps what it alerted); erased with the tenant. SQLite twin: migratePlayAlerts.
-- 0068 = main's highest (0067) + 1 (~/work/migration_claims.txt).
CREATE TABLE play_alerts (
    tenant_id   TEXT NOT NULL,
    entity_key  TEXT NOT NULL,
    play_kind   TEXT NOT NULL CHECK (play_kind IN ('watch','monitor')),
    play_id     TEXT NOT NULL,
    job_id      TEXT NOT NULL,
    event_date  TEXT,
    signal_kind TEXT,
    domain_key  TEXT,
    at          BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, entity_key)
  );

CREATE OR REPLACE FUNCTION dazl_guard_tomb_play_alerts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_play_alerts ON play_alerts;
CREATE TRIGGER tomb_play_alerts BEFORE INSERT ON play_alerts FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_play_alerts();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_play_alerts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_play_alerts ON play_alerts;
CREATE TRIGGER tomb_upd_play_alerts BEFORE UPDATE OF tenant_id ON play_alerts FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_play_alerts();
