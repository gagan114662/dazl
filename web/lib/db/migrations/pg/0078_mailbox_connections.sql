CREATE TABLE mailbox_connections (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('smtp', 'gmail', 'outlook')),
  smtp_host TEXT,
  smtp_port BIGINT,
  smtp_username TEXT,
  smtp_password_encrypted TEXT,
  imap_host TEXT,
  imap_port BIGINT,
  imap_username TEXT,
  imap_password_encrypted TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, provider)
);

CREATE OR REPLACE FUNCTION dazl_guard_tomb_mailbox_connections() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_mailbox_connections ON mailbox_connections;
CREATE TRIGGER tomb_mailbox_connections BEFORE INSERT ON mailbox_connections FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_mailbox_connections();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_mailbox_connections() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_mailbox_connections ON mailbox_connections;
CREATE TRIGGER tomb_upd_mailbox_connections BEFORE UPDATE OF tenant_id ON mailbox_connections FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_mailbox_connections();
