-- Display-only company-first work email observations; not a sender or candidate table.

CREATE TABLE company_first_published_email_display (
   tenant_id TEXT NOT NULL,
   lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
   scan_job_id TEXT NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
   attempt BIGINT NOT NULL CHECK (attempt >= 0),
   version BIGINT NOT NULL CHECK (version = 1),
   domain TEXT NOT NULL CHECK (char_length(domain) <= 253),
   person TEXT NOT NULL CHECK (char_length(person) <= 120),
   address TEXT NOT NULL CHECK (char_length(address) <= 254),
   source_url TEXT NOT NULL CHECK (char_length(source_url) <= 500),
   role_quote TEXT NOT NULL CHECK (char_length(role_quote) <= 60),
   observed_at BIGINT NOT NULL CHECK (observed_at > 0),
   PRIMARY KEY (tenant_id, lead_id)
 );

CREATE OR REPLACE FUNCTION dazl_guard_tomb_company_first_published_email_display() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_company_first_published_email_display ON company_first_published_email_display;
CREATE TRIGGER tomb_company_first_published_email_display BEFORE INSERT ON company_first_published_email_display FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_company_first_published_email_display();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_company_first_published_email_display() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_company_first_published_email_display ON company_first_published_email_display;
CREATE TRIGGER tomb_upd_company_first_published_email_display BEFORE UPDATE OF tenant_id ON company_first_published_email_display FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_company_first_published_email_display();
