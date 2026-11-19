-- Isolate Canada/UK name-attributed public proof from recipient and verifier tables.

CREATE TABLE published_work_email_display (
    tenant_id TEXT NOT NULL,
    lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    jurisdiction TEXT NOT NULL CHECK (jurisdiction IN ('CA','GB')),
    person TEXT NOT NULL CHECK (char_length(person) <= 120),
    address TEXT NOT NULL CHECK (char_length(address) <= 254),
    source_url TEXT NOT NULL CHECK (char_length(source_url) <= 500),
    PRIMARY KEY (tenant_id, lead_id, person, address)
  );

CREATE OR REPLACE FUNCTION dazl_guard_tomb_published_work_email_display() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_published_work_email_display ON published_work_email_display;
CREATE TRIGGER tomb_published_work_email_display BEFORE INSERT ON published_work_email_display FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_published_work_email_display();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_published_work_email_display() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_published_work_email_display ON published_work_email_display;
CREATE TRIGGER tomb_upd_published_work_email_display BEFORE UPDATE OF tenant_id ON published_work_email_display FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_published_work_email_display();
