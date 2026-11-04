-- #385: reasoned lead feedback (lib/scan/feedback.ts, docs/design/lead-feedback.md). A tenant's explicit accept /
-- reject verdict on an account, person or event, applied to later runs until it is reset (reset_at and reset_reason
-- keep the history). (tenant_id, version) is unique: each verdict takes the tenant's next version. Tomb guards per 0039.
CREATE TABLE lead_feedback (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    version BIGINT NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('accept', 'reject')),
    level TEXT NOT NULL CHECK (level IN ('account', 'person', 'event')),
    reason TEXT CHECK (reason IS NULL OR reason IN ('wrong_industry', 'wrong_location', 'competitor', 'existing_relationship', 'not_useful', 'wrong_person', 'wrong_timing')),
    company_key TEXT NOT NULL,
    domain TEXT,
    person_name TEXT,
    person_contact TEXT,
    event_date TEXT,
    source_host TEXT,
    signal_kind TEXT,
    lead_id TEXT,
    job_id TEXT,
    actor_id TEXT,
    note TEXT CHECK (note IS NULL OR char_length(note) <= 300),
    created_at BIGINT NOT NULL,
    reset_at BIGINT,
    reset_reason TEXT CHECK (reset_reason IS NULL OR char_length(reset_reason) <= 200)
  );

CREATE INDEX lead_feedback_active ON lead_feedback (tenant_id, reset_at);

CREATE UNIQUE INDEX lead_feedback_version ON lead_feedback (tenant_id, version);

CREATE OR REPLACE FUNCTION dazl_guard_tomb_lead_feedback() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_lead_feedback ON lead_feedback;
CREATE TRIGGER tomb_lead_feedback BEFORE INSERT ON lead_feedback FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_lead_feedback();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_lead_feedback() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_lead_feedback ON lead_feedback;
CREATE TRIGGER tomb_upd_lead_feedback BEFORE UPDATE OF tenant_id ON lead_feedback FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_lead_feedback();
