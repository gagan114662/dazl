-- Workspace stall observation timestamps and daily notification claims.
CREATE TABLE workspace_stall_state (
    tenant_id TEXT PRIMARY KEY,
    gmail_since BIGINT,
    sequences_since BIGINT,
    reply_since BIGINT,
    mail_at BIGINT,
    operator_at BIGINT
  );

CREATE OR REPLACE FUNCTION dazl_guard_tomb_workspace_stall_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_workspace_stall_state ON workspace_stall_state;
CREATE TRIGGER tomb_workspace_stall_state BEFORE INSERT ON workspace_stall_state FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_workspace_stall_state();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_workspace_stall_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_workspace_stall_state ON workspace_stall_state;
CREATE TRIGGER tomb_upd_workspace_stall_state BEFORE UPDATE OF tenant_id ON workspace_stall_state FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_workspace_stall_state();
