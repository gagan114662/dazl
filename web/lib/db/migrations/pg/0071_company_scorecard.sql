-- Protected scorecard opt-in only. No existing workspace gains access.
ALTER TABLE organizations ADD COLUMN company_first_scorecard_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (company_first_scorecard_enabled IN (0, 1));
ALTER TABLE organizations ADD COLUMN company_first_scorecard_revision TEXT
  CHECK (company_first_scorecard_revision IS NULL OR length(company_first_scorecard_revision) = 64);

CREATE TABLE IF NOT EXISTS company_scorecard_cohorts (
    cohort TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_revision TEXT NOT NULL, release TEXT NOT NULL, roster TEXT NOT NULL, next_ordinal INTEGER NOT NULL CHECK(next_ordinal BETWEEN 1 AND 8)
  );
CREATE TABLE IF NOT EXISTS company_scorecard_claims (
    nonce TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
    cohort TEXT NOT NULL REFERENCES company_scorecard_cohorts(cohort) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 7), job_id TEXT NOT NULL,
    subject_mac TEXT NOT NULL CHECK(length(subject_mac)=64),
    attempt INTEGER NOT NULL CHECK(attempt > 0), expires_at BIGINT NOT NULL,
    lane INTEGER NOT NULL CHECK(lane BETWEEN 0 AND 2),
    status TEXT NOT NULL CHECK(status IN ('running','complete')),
    UNIQUE(cohort, ordinal, lane), UNIQUE(job_id)
  );
CREATE TABLE IF NOT EXISTS company_scorecard_calls (
    reservation_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
    nonce TEXT NOT NULL REFERENCES company_scorecard_claims(nonce) ON DELETE CASCADE,
    lane INTEGER NOT NULL CHECK(lane BETWEEN 0 AND 2)
  );
-- Dedicated scorecard jobs are inserted as running by the protected path;
-- a tagged job must never be visible to a legacy pending claim/retry.
ALTER TABLE scan_jobs ADD COLUMN company_scorecard_claim_nonce TEXT
  CHECK (company_scorecard_claim_nonce IS NULL OR status <> 'pending');
ALTER TABLE scan_jobs ADD COLUMN company_scorecard_dispatch_started_at BIGINT;
ALTER TABLE scan_jobs ADD COLUMN company_scorecard_dispatch_release TEXT
  CHECK (company_scorecard_dispatch_release IS NULL OR company_scorecard_dispatch_release ~ '^[0-9a-f]{40}$');

CREATE FUNCTION dazl_company_scorecard_marker_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.company_scorecard_claim_nonce IS DISTINCT FROM NEW.company_scorecard_claim_nonce AND NOT (
    OLD.company_scorecard_claim_nonce IS NULL AND NEW.company_scorecard_claim_nonce IS NOT NULL
    AND length(NEW.company_scorecard_claim_nonce)=64
    AND OLD.status='running' AND NEW.status='running' AND OLD.attempts=1 AND NEW.attempts=1
    AND OLD.company_scorecard_dispatch_started_at IS NULL AND NEW.company_scorecard_dispatch_started_at IS NULL
    AND NEW.id=OLD.id AND NEW.user_id=OLD.user_id
    AND EXISTS (SELECT 1 FROM company_scorecard_claims c
      WHERE c.nonce=NEW.company_scorecard_claim_nonce AND c.job_id=NEW.id
        AND c.tenant_id=NEW.user_id AND c.attempt=NEW.attempts AND c.status='running')
  ) THEN
    RAISE EXCEPTION 'scorecard marker immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_scorecard_marker_immutable
  BEFORE UPDATE OF company_scorecard_claim_nonce ON scan_jobs
  FOR EACH ROW EXECUTE FUNCTION dazl_company_scorecard_marker_immutable();

CREATE FUNCTION dazl_company_scorecard_dispatch_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.company_scorecard_dispatch_started_at IS DISTINCT FROM NEW.company_scorecard_dispatch_started_at
      OR OLD.company_scorecard_dispatch_release IS DISTINCT FROM NEW.company_scorecard_dispatch_release) AND NOT (
    OLD.company_scorecard_dispatch_started_at IS NULL AND OLD.company_scorecard_dispatch_release IS NULL
    AND NEW.company_scorecard_dispatch_started_at IS NOT NULL AND NEW.company_scorecard_dispatch_started_at > 0
    AND NEW.company_scorecard_dispatch_release IS NOT NULL AND OLD.status='running' AND NEW.status='running'
    AND NEW.company_scorecard_claim_nonce IS NOT DISTINCT FROM OLD.company_scorecard_claim_nonce
    AND NEW.id=OLD.id AND NEW.user_id=OLD.user_id AND NEW.attempts=OLD.attempts
    AND EXISTS (SELECT 1 FROM company_scorecard_claims c JOIN company_scorecard_cohorts p ON p.cohort=c.cohort
      WHERE c.nonce=NEW.company_scorecard_claim_nonce AND c.job_id=NEW.id AND c.attempt=NEW.attempts
        AND p.tenant_id=NEW.user_id AND p.release=NEW.company_scorecard_dispatch_release AND c.status='running')
  ) THEN
    RAISE EXCEPTION 'scorecard dispatch stamp immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_scorecard_dispatch_stamp
  BEFORE UPDATE OF company_scorecard_dispatch_started_at, company_scorecard_dispatch_release ON scan_jobs
  FOR EACH ROW EXECUTE FUNCTION dazl_company_scorecard_dispatch_stamp();

CREATE FUNCTION dazl_company_scorecard_no_handback() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.company_scorecard_claim_nonce IS NOT NULL AND OLD.status='running' AND NEW.status='pending' THEN
    NEW.status := 'failed';
    NEW.claimed_at := NULL;
    NEW.finished_at := CAST(floor(extract(epoch FROM now())) AS BIGINT);
    IF EXISTS (SELECT 1 FROM scan_spend_calls c WHERE c.scan_job_id=OLD.id AND c.status='reserved') THEN
      NEW.error := 'accounting_uncertain';
    ELSE
      NEW.error := 'scorecard_dispatch_failed';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_scorecard_no_handback
  BEFORE UPDATE OF status ON scan_jobs
  FOR EACH ROW EXECUTE FUNCTION dazl_company_scorecard_no_handback();

CREATE FUNCTION dazl_company_scorecard_tenant_live() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant=NEW.tenant_id) THEN
    RAISE EXCEPTION 'tenant deleted';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_scorecard_cohorts_tenant_live
  BEFORE INSERT OR UPDATE OF tenant_id ON company_scorecard_cohorts
  FOR EACH ROW EXECUTE FUNCTION dazl_company_scorecard_tenant_live();
CREATE TRIGGER company_scorecard_claims_tenant_live
  BEFORE INSERT OR UPDATE OF tenant_id ON company_scorecard_claims
  FOR EACH ROW EXECUTE FUNCTION dazl_company_scorecard_tenant_live();
CREATE TRIGGER company_scorecard_calls_tenant_live
  BEFORE INSERT OR UPDATE OF tenant_id ON company_scorecard_calls
  FOR EACH ROW EXECUTE FUNCTION dazl_company_scorecard_tenant_live();

CREATE FUNCTION dazl_company_scorecard_actor_live() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant=NEW.actor_id) THEN
    RAISE EXCEPTION 'tenant deleted';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_scorecard_cohorts_actor_live
  BEFORE INSERT OR UPDATE OF actor_id ON company_scorecard_cohorts
  FOR EACH ROW EXECUTE FUNCTION dazl_company_scorecard_actor_live();
