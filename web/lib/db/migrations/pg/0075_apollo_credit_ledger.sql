CREATE TABLE apollo_credit_ledger (
  tenant_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  credit BIGINT NOT NULL DEFAULT 1,
  result TEXT NOT NULL DEFAULT 'reserved',
  PRIMARY KEY (tenant_id, lead_id)
);

CREATE OR REPLACE FUNCTION dazl_guard_tomb_apollo_credit_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_apollo_credit_ledger ON apollo_credit_ledger;
CREATE TRIGGER tomb_apollo_credit_ledger BEFORE INSERT ON apollo_credit_ledger FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_apollo_credit_ledger();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_apollo_credit_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_apollo_credit_ledger ON apollo_credit_ledger;
CREATE TRIGGER tomb_upd_apollo_credit_ledger BEFORE UPDATE OF tenant_id ON apollo_credit_ledger FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_apollo_credit_ledger();
