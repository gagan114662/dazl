-- #377 / #533: the hard per-scan spend cap (lib/scan/spend-cap.ts). Each scan job carries its own spend ledger (the cap it
-- runs under, what its paid calls have reserved, and how many were refused), and every paid provider call a scan makes is
-- one scan_spend_calls row: reserved at its worst case before the request, then settled to the vendor-reported cost,
-- kept at the worst case, or refused. The cap column holds at most USD 3.3334 (CAD 5 at the 1.50 CAD/USD floor).
-- Numbered 0048: main's highest is 0047_reply_checkpoints. Tomb guards per 0039.
ALTER TABLE scan_jobs ADD COLUMN spend_cap_usd DOUBLE PRECISION CHECK (spend_cap_usd IS NULL OR (spend_cap_usd > 0 AND spend_cap_usd <= 3.3334));

ALTER TABLE scan_jobs ADD COLUMN spend_cap_reserved_usd DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (spend_cap_reserved_usd >= 0);

ALTER TABLE scan_jobs ADD COLUMN spend_cap_refusals BIGINT NOT NULL DEFAULT 0;

CREATE TABLE scan_spend_calls (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      scan_job_id TEXT NOT NULL,
      attempt     BIGINT NOT NULL,
      kind        TEXT NOT NULL CHECK (char_length(kind) <= 32),
      reserve_usd DOUBLE PRECISION NOT NULL CHECK (reserve_usd >= 0),
      actual_usd  DOUBLE PRECISION CHECK (actual_usd IS NULL OR actual_usd >= 0),
      status      TEXT NOT NULL CHECK (status IN ('reserved','settled','kept','refused')),
      reason      TEXT CHECK (reason IS NULL OR char_length(reason) <= 80),
      created_at  BIGINT NOT NULL,
      settled_at  BIGINT
    );

CREATE INDEX scan_spend_calls_job ON scan_spend_calls (user_id, scan_job_id);

CREATE OR REPLACE FUNCTION dazl_guard_tomb_scan_spend_calls() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.user_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.user_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_scan_spend_calls ON scan_spend_calls;
CREATE TRIGGER tomb_scan_spend_calls BEFORE INSERT ON scan_spend_calls FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_scan_spend_calls();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_scan_spend_calls() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.user_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.user_id));
  IF (NEW.user_id IS DISTINCT FROM OLD.user_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.user_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.user_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_scan_spend_calls ON scan_spend_calls;
CREATE TRIGGER tomb_upd_scan_spend_calls BEFORE UPDATE OF user_id ON scan_spend_calls FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_scan_spend_calls();
