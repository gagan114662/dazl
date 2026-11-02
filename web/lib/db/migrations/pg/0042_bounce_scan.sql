-- Bounce handling (#415): per-send bounce ledger (the dedup unit is the original send + recipient, never the
-- Gmail notice id) and the separate, exact-version consent for the delivery-failure scan. Next number on this
-- branch; main already carries through 0041, so this file was RENUMBERED 0026 -> 0042 at merge reconcile.
CREATE TABLE bounce_records (
      tenant_id TEXT NOT NULL, outreach_message_id TEXT NOT NULL, recipient TEXT NOT NULL,
      status TEXT NOT NULL, source TEXT NOT NULL, source_gmail_id TEXT, created_at BIGINT NOT NULL,
      PRIMARY KEY (tenant_id, outreach_message_id, recipient)
    );

CREATE TABLE mail_bounce_scan_consent (tenant_id TEXT PRIMARY KEY, version TEXT NOT NULL, accepted_at BIGINT NOT NULL DEFAULT (CAST(floor(extract(epoch from now())) AS BIGINT)));

-- Tenant-deletion guards over the two new tables (same generated shape as 0040): a tombstoned tenant can
-- neither gain nor keep bounce rows or scan consent.

CREATE OR REPLACE FUNCTION dazl_guard_tomb_bounce_records() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_bounce_records ON bounce_records;
CREATE TRIGGER tomb_bounce_records BEFORE INSERT ON bounce_records FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_bounce_records();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_bounce_records() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_bounce_records ON bounce_records;
CREATE TRIGGER tomb_upd_bounce_records BEFORE UPDATE OF tenant_id ON bounce_records FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_bounce_records();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_mail_bounce_scan_consent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_mail_bounce_scan_consent ON mail_bounce_scan_consent;
CREATE TRIGGER tomb_mail_bounce_scan_consent BEFORE INSERT ON mail_bounce_scan_consent FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_mail_bounce_scan_consent();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_mail_bounce_scan_consent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_mail_bounce_scan_consent ON mail_bounce_scan_consent;
CREATE TRIGGER tomb_upd_mail_bounce_scan_consent BEFORE UPDATE OF tenant_id ON mail_bounce_scan_consent FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_mail_bounce_scan_consent();
