-- LOCAL PLACEHOLDER - number must be reassigned to main's highest + 1 AT MERGE TIME (numbering contract, refs #373).
-- First-party consent withdrawal tombstones (lib/signals/first-party.ts, #390 review / #618). The minimum record
-- that stops an older-dated grant arriving after a withdrawal from resurrecting the subject: tenant,
-- deterministic tenant-namespaced person key (sha256 of tenantId|email, truncated), withdrawal time. No email, no
-- name. Purged with the tenant's recorded retention; erased by eraseFirstParty.
-- Additive only; tenant-scoped; tomb guards per 0039.
CREATE TABLE first_party_withdrawals (
    tenant_id TEXT NOT NULL,
    person_key TEXT NOT NULL,
    withdrawn_at BIGINT NOT NULL,
    recorded_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, person_key)
  );

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_first_party_withdrawals() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_first_party_withdrawals ON first_party_withdrawals;
CREATE TRIGGER tomb_upd_first_party_withdrawals BEFORE UPDATE OF tenant_id ON first_party_withdrawals FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_first_party_withdrawals();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_first_party_withdrawals() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_first_party_withdrawals ON first_party_withdrawals;
CREATE TRIGGER tomb_first_party_withdrawals BEFORE INSERT ON first_party_withdrawals FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_first_party_withdrawals();

-- Plaintext retention metadata, written in the same transaction as every recordConfig: when the encrypted config
-- cannot be read (corrupt, wrong key), the retention tick still enforces the last recorded period instead of
-- skipping the tenant and letting events and tombstones live until erase. No secret material here.
CREATE TABLE first_party_config_meta (
    tenant_id      TEXT PRIMARY KEY,
    retention_days BIGINT NOT NULL,
    recorded_at    BIGINT NOT NULL,
    last_purge_at  BIGINT
  );

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_first_party_config_meta() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_first_party_config_meta ON first_party_config_meta;
CREATE TRIGGER tomb_upd_first_party_config_meta BEFORE UPDATE OF tenant_id ON first_party_config_meta FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_first_party_config_meta();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_first_party_config_meta() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_first_party_config_meta ON first_party_config_meta;
CREATE TRIGGER tomb_first_party_config_meta BEFORE INSERT ON first_party_config_meta FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_first_party_config_meta();
