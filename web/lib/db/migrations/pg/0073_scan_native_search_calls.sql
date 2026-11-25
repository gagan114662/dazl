CREATE TABLE IF NOT EXISTS scan_native_search_calls (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  scan_job_id TEXT NOT NULL,
  attempt BIGINT NOT NULL,
  allowance BIGINT NOT NULL CHECK (allowance >= 0 AND allowance <= 15),
  used BIGINT CHECK (used IS NULL OR (used >= 0 AND used <= allowance))
);
CREATE INDEX IF NOT EXISTS scan_native_search_calls_job ON scan_native_search_calls(user_id,scan_job_id);
-- Previously dispatched searches have no trustworthy counter: retain the whole allowance.
INSERT INTO scan_native_search_calls(id,user_id,scan_job_id,attempt,allowance,used)
SELECT 'legacy:' || s.scan_job_id,s.user_id,s.scan_job_id,MAX(s.attempt),15,NULL
FROM scan_spend_calls s
WHERE s.kind = 'llm.anthropic.web_search' AND s.status <> 'refused'
  AND NOT EXISTS (SELECT 1 FROM scan_native_search_calls n WHERE n.scan_job_id = s.scan_job_id AND n.user_id = s.user_id)
GROUP BY s.user_id,s.scan_job_id;

CREATE OR REPLACE FUNCTION dazl_guard_tomb_scan_native_search_calls() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.user_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.user_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_scan_native_search_calls ON scan_native_search_calls;
CREATE TRIGGER tomb_scan_native_search_calls BEFORE INSERT ON scan_native_search_calls FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_scan_native_search_calls();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_scan_native_search_calls() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.user_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.user_id));
  IF (NEW.user_id IS DISTINCT FROM OLD.user_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.user_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.user_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_scan_native_search_calls ON scan_native_search_calls;
CREATE TRIGGER tomb_upd_scan_native_search_calls BEFORE UPDATE OF user_id ON scan_native_search_calls FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_scan_native_search_calls();
