-- #417: opted-in onboarding/customer-success policy (lib/outreach/onboarding-policy.ts). After a prospect
-- converts, any automated onboarding/customer-success mail requires this explicit, auditable opt-in; the gate
-- (policy + activated conversion + enrollment) fails closed. Tomb guards per 0039. onboarding_audit is
-- append-only consent evidence (update/delete refused, no gate exception) and content-free at the source.
CREATE TABLE onboarding_audit (
      id         TEXT PRIMARY KEY,
      tenant_id  TEXT NOT NULL,
      action     TEXT NOT NULL,
      detail     TEXT,
      created_at BIGINT NOT NULL
    );

CREATE TABLE onboarding_enrollments (
      tenant_id   TEXT NOT NULL,
      email       TEXT NOT NULL,
      source      TEXT NOT NULL,
      enrolled_at BIGINT NOT NULL,
      PRIMARY KEY (tenant_id, email)
    );

CREATE TABLE onboarding_policies (
      tenant_id      TEXT PRIMARY KEY,
      policy_version TEXT NOT NULL,
      opted_in_by    TEXT NOT NULL,
      opted_in_at    BIGINT NOT NULL,
      withdrawn_at   BIGINT
    );


CREATE INDEX onboarding_audit_tenant ON onboarding_audit (tenant_id, created_at);

CREATE OR REPLACE FUNCTION dazl_guard_tomb_onboarding_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_onboarding_audit ON onboarding_audit;
CREATE TRIGGER tomb_onboarding_audit BEFORE INSERT ON onboarding_audit FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_onboarding_audit();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_onboarding_enrollments() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_onboarding_enrollments ON onboarding_enrollments;
CREATE TRIGGER tomb_onboarding_enrollments BEFORE INSERT ON onboarding_enrollments FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_onboarding_enrollments();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_onboarding_policies() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_onboarding_policies ON onboarding_policies;
CREATE TRIGGER tomb_onboarding_policies BEFORE INSERT ON onboarding_policies FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_onboarding_policies();


CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_onboarding_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_onboarding_audit ON onboarding_audit;
CREATE TRIGGER tomb_upd_onboarding_audit BEFORE UPDATE OF tenant_id ON onboarding_audit FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_onboarding_audit();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_onboarding_enrollments() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_onboarding_enrollments ON onboarding_enrollments;
CREATE TRIGGER tomb_upd_onboarding_enrollments BEFORE UPDATE OF tenant_id ON onboarding_enrollments FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_onboarding_enrollments();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_onboarding_policies() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_onboarding_policies ON onboarding_policies;
CREATE TRIGGER tomb_upd_onboarding_policies BEFORE UPDATE OF tenant_id ON onboarding_policies FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_onboarding_policies();


CREATE OR REPLACE FUNCTION dazl_guard_onboarding_audit_no_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TRUE) THEN RAISE EXCEPTION 'onboarding audit is append-only'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS onboarding_audit_no_update ON onboarding_audit;
CREATE TRIGGER onboarding_audit_no_update BEFORE UPDATE ON onboarding_audit FOR EACH ROW EXECUTE FUNCTION dazl_guard_onboarding_audit_no_update();

CREATE OR REPLACE FUNCTION dazl_guard_onboarding_audit_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TRUE) THEN RAISE EXCEPTION 'onboarding audit is append-only'; END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS onboarding_audit_no_delete ON onboarding_audit;
CREATE TRIGGER onboarding_audit_no_delete BEFORE DELETE ON onboarding_audit FOR EACH ROW EXECUTE FUNCTION dazl_guard_onboarding_audit_no_delete();
