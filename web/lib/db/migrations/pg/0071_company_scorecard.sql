-- Protected scorecard opt-in only. No existing workspace gains access.
ALTER TABLE organizations ADD COLUMN company_first_scorecard_enabled BIGINT NOT NULL DEFAULT 0
  CHECK (company_first_scorecard_enabled IN (0, 1));
ALTER TABLE organizations ADD COLUMN company_first_scorecard_revision TEXT
  CHECK (company_first_scorecard_revision IS NULL OR char_length(company_first_scorecard_revision) = 64);

CREATE TABLE IF NOT EXISTS company_scorecard_cohorts (
    cohort TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_revision TEXT NOT NULL, release TEXT NOT NULL, roster TEXT NOT NULL, next_ordinal BIGINT NOT NULL CHECK(next_ordinal BETWEEN 1 AND 8)
  );
CREATE TABLE IF NOT EXISTS company_scorecard_claims (
    nonce TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
    cohort TEXT NOT NULL REFERENCES company_scorecard_cohorts(cohort) ON DELETE CASCADE,
    ordinal BIGINT NOT NULL CHECK(ordinal BETWEEN 1 AND 7), job_id TEXT NOT NULL,
    subject_mac TEXT NOT NULL CHECK(char_length(subject_mac)=64),
    attempt BIGINT NOT NULL CHECK(attempt > 0), expires_at BIGINT NOT NULL,
    lane BIGINT NOT NULL CHECK(lane BETWEEN 0 AND 2),
    status TEXT NOT NULL CHECK(status IN ('running','complete')),
    UNIQUE(cohort, ordinal, lane), UNIQUE(job_id)
  );
CREATE TABLE IF NOT EXISTS company_scorecard_calls (
    reservation_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
    nonce TEXT NOT NULL REFERENCES company_scorecard_claims(nonce) ON DELETE CASCADE,
    lane BIGINT NOT NULL CHECK(lane BETWEEN 0 AND 2)
  );
-- Dedicated scorecard jobs are inserted as running by the protected path;
-- a tagged job must never be visible to a legacy pending claim/retry.
ALTER TABLE scan_jobs ADD COLUMN company_scorecard_claim_nonce TEXT
  CHECK (company_scorecard_claim_nonce IS NULL OR status <> 'pending');
ALTER TABLE scan_jobs ADD COLUMN company_scorecard_dispatch_started_at BIGINT;
ALTER TABLE scan_jobs ADD COLUMN company_scorecard_dispatch_release TEXT
  CHECK (company_scorecard_dispatch_release IS NULL OR company_scorecard_dispatch_release ~ '^[0-9a-f]{40}$');

-- Use the exact canonical translated guards, including advisory locks for tenant/actor moves.
CREATE OR REPLACE FUNCTION dazl_guard_tomb_company_scorecard_calls() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_company_scorecard_calls ON company_scorecard_calls;
CREATE TRIGGER tomb_company_scorecard_calls BEFORE INSERT ON company_scorecard_calls FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_company_scorecard_calls();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_company_scorecard_claims() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_company_scorecard_claims ON company_scorecard_claims;
CREATE TRIGGER tomb_company_scorecard_claims BEFORE INSERT ON company_scorecard_claims FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_company_scorecard_claims();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_company_scorecard_cohorts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_company_scorecard_cohorts ON company_scorecard_cohorts;
CREATE TRIGGER tomb_company_scorecard_cohorts BEFORE INSERT ON company_scorecard_cohorts FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_company_scorecard_cohorts();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_company_scorecard_cohorts_actor_id() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.actor_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.actor_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_company_scorecard_cohorts_actor_id ON company_scorecard_cohorts;
CREATE TRIGGER tomb_company_scorecard_cohorts_actor_id BEFORE INSERT ON company_scorecard_cohorts FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_company_scorecard_cohorts_actor_id();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_company_scorecard_calls() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_company_scorecard_calls ON company_scorecard_calls;
CREATE TRIGGER tomb_upd_company_scorecard_calls BEFORE UPDATE OF tenant_id ON company_scorecard_calls FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_company_scorecard_calls();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_company_scorecard_claims() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_company_scorecard_claims ON company_scorecard_claims;
CREATE TRIGGER tomb_upd_company_scorecard_claims BEFORE UPDATE OF tenant_id ON company_scorecard_claims FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_company_scorecard_claims();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_company_scorecard_cohorts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_company_scorecard_cohorts ON company_scorecard_cohorts;
CREATE TRIGGER tomb_upd_company_scorecard_cohorts BEFORE UPDATE OF tenant_id ON company_scorecard_cohorts FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_company_scorecard_cohorts();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_company_scorecard_cohorts_actor_id() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.actor_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.actor_id));
  IF (NEW.actor_id IS DISTINCT FROM OLD.actor_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.actor_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.actor_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_company_scorecard_cohorts_actor_id ON company_scorecard_cohorts;
CREATE TRIGGER tomb_upd_company_scorecard_cohorts_actor_id BEFORE UPDATE OF actor_id ON company_scorecard_cohorts FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_company_scorecard_cohorts_actor_id();

CREATE OR REPLACE FUNCTION dazl_guard_company_scorecard_dispatch_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ((OLD.company_scorecard_dispatch_started_at IS DISTINCT FROM NEW.company_scorecard_dispatch_started_at
          OR OLD.company_scorecard_dispatch_release IS DISTINCT FROM NEW.company_scorecard_dispatch_release) AND NOT (
      OLD.company_scorecard_dispatch_started_at IS NULL AND OLD.company_scorecard_dispatch_release IS NULL
      AND NEW.company_scorecard_dispatch_started_at IS DISTINCT FROM NULL AND NEW.company_scorecard_dispatch_started_at > 0
      AND NEW.company_scorecard_dispatch_release IS DISTINCT FROM NULL AND OLD.status='running' AND NEW.status='running'
      AND NEW.company_scorecard_claim_nonce=OLD.company_scorecard_claim_nonce
      AND NEW.id=OLD.id AND NEW.user_id=OLD.user_id AND NEW.attempts=OLD.attempts
      AND EXISTS (SELECT 1 FROM company_scorecard_claims c JOIN company_scorecard_cohorts p ON p.cohort=c.cohort
        WHERE c.nonce=NEW.company_scorecard_claim_nonce AND c.job_id=NEW.id AND c.attempt=NEW.attempts
          AND p.tenant_id=NEW.user_id AND p.release=NEW.company_scorecard_dispatch_release AND c.status='running')
    )) THEN RAISE EXCEPTION 'scorecard dispatch stamp immutable'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS company_scorecard_dispatch_stamp ON scan_jobs;
CREATE TRIGGER company_scorecard_dispatch_stamp BEFORE UPDATE OF company_scorecard_dispatch_started_at, company_scorecard_dispatch_release ON scan_jobs FOR EACH ROW EXECUTE FUNCTION dazl_guard_company_scorecard_dispatch_stamp();

CREATE OR REPLACE FUNCTION dazl_guard_company_scorecard_marker_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.company_scorecard_claim_nonce IS DISTINCT FROM NEW.company_scorecard_claim_nonce AND NOT (
      OLD.company_scorecard_claim_nonce IS NULL AND NEW.company_scorecard_claim_nonce IS DISTINCT FROM NULL
      AND length(NEW.company_scorecard_claim_nonce) = 64
      AND OLD.status='running' AND NEW.status='running' AND OLD.attempts=1 AND NEW.attempts=1
      AND OLD.company_scorecard_dispatch_started_at IS NULL AND NEW.company_scorecard_dispatch_started_at IS NULL
      AND NEW.id=OLD.id AND NEW.user_id=OLD.user_id
      AND EXISTS (SELECT 1 FROM company_scorecard_claims c
        WHERE c.nonce=NEW.company_scorecard_claim_nonce AND c.job_id=NEW.id
          AND c.tenant_id=NEW.user_id AND c.attempt=NEW.attempts AND c.status='running')
    )) THEN RAISE EXCEPTION 'scorecard marker immutable'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS company_scorecard_marker_immutable ON scan_jobs;
CREATE TRIGGER company_scorecard_marker_immutable BEFORE UPDATE OF company_scorecard_claim_nonce ON scan_jobs FOR EACH ROW EXECUTE FUNCTION dazl_guard_company_scorecard_marker_immutable();

CREATE OR REPLACE FUNCTION dazl_guard_company_scorecard_no_handback() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.company_scorecard_claim_nonce IS NOT NULL AND OLD.status='running' AND NEW.status='pending') THEN
    UPDATE scan_jobs SET status='failed', claimed_at=NULL, finished_at=floor(extract(epoch from now())),
      error=CASE WHEN EXISTS (SELECT 1 FROM scan_spend_calls c WHERE c.scan_job_id=OLD.id AND c.status='reserved')
        THEN 'accounting_uncertain' ELSE 'scorecard_dispatch_failed' END
    WHERE id=OLD.id AND user_id=OLD.user_id AND status='running' AND attempts=OLD.attempts;
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS company_scorecard_no_handback ON scan_jobs;
CREATE TRIGGER company_scorecard_no_handback BEFORE UPDATE OF status ON scan_jobs FOR EACH ROW EXECUTE FUNCTION dazl_guard_company_scorecard_no_handback();
