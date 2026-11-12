-- #1036 Find work email (lib/people/work-email.ts): one row per (tenant, lead, person) lookup with its outcome. The row is
-- claimed as 'pending' BEFORE any paid call, so a replay or double click never pays twice. 'verified' needs Apollo and
-- a check time, 'published' needs the site page, 'unverified' needs apollo/pdl (a NULL provider never passes: COALESCE),
-- and an address is stored only for verified / published / unverified.
-- SQLite twin: migrateWorkEmail. 0061 = main's highest (0060) + 1 (~/work/migration_claims.txt).
CREATE TABLE work_email_lookups (
      tenant_id  TEXT NOT NULL,
      lead_id    TEXT NOT NULL,
      target     TEXT NOT NULL CHECK (char_length(target) <= 200),
      status     TEXT NOT NULL CHECK (status IN ('pending','verified','published','unverified','not_found','not_us','rejected','error','uncertain')),
      provider   TEXT CHECK (provider IS NULL OR provider IN ('site','apollo','pdl')),
      address    TEXT CHECK (address IS NULL OR char_length(address) <= 254),
      detail     TEXT CHECK (detail IS NULL OR char_length(detail) <= 300),
      source_url TEXT CHECK (source_url IS NULL OR char_length(source_url) <= 500),
      checked_at BIGINT,
      updated_at BIGINT NOT NULL,
      CHECK ((address IS NOT NULL) = (status IN ('verified','published','unverified'))),
      CHECK (status <> 'verified' OR (COALESCE(provider, '') = 'apollo' AND checked_at IS NOT NULL)),
      CHECK (status <> 'published' OR (COALESCE(provider, '') = 'site' AND source_url IS NOT NULL)),
      CHECK (status <> 'unverified' OR COALESCE(provider, '') IN ('apollo','pdl')),
      PRIMARY KEY (tenant_id, lead_id, target)
    );

CREATE OR REPLACE FUNCTION dazl_guard_tomb_work_email_lookups() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_work_email_lookups ON work_email_lookups;
CREATE TRIGGER tomb_work_email_lookups BEFORE INSERT ON work_email_lookups FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_work_email_lookups();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_work_email_lookups() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_work_email_lookups ON work_email_lookups;
CREATE TRIGGER tomb_upd_work_email_lookups BEFORE UPDATE OF tenant_id ON work_email_lookups FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_work_email_lookups();
