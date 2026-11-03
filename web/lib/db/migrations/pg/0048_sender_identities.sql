-- #370: provider-independent sender identities (lib/outreach/senders.ts). A workspace keeps its primary Gmail
-- connection (gmail_accounts) and may add verified sender identities, each owned by the member who connected it, with
-- its own encrypted credential (context sender-refresh:<tenant>:<id>), its own warm-up/cap, and an approval hash that
-- covers the identity. outreach_messages.sender_id binds a message to one (NULL = the primary connection);
-- oauth_states.sender_owner marks a connect that adds an identity, bound to the member who started it.
-- Tomb guards per 0039 (same generated shape as 0042/0043).
CREATE TABLE sender_identities (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL,
    provider        TEXT NOT NULL CHECK (provider IN ('gmail')),
    email           TEXT NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
    owner_member_id TEXT NOT NULL,
    refresh_ct      TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','needs_reconnect')),
    verified_at     BIGINT NOT NULL,
    created_at      BIGINT NOT NULL DEFAULT (CAST(floor(extract(epoch from now())) AS BIGINT)),
    UNIQUE (tenant_id, provider, email)
  );

CREATE INDEX sender_identities_tenant ON sender_identities (tenant_id, status);

ALTER TABLE outreach_messages ADD COLUMN sender_id TEXT;

ALTER TABLE oauth_states ADD COLUMN sender_owner TEXT;

CREATE OR REPLACE FUNCTION dazl_guard_tomb_sender_identities() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_sender_identities ON sender_identities;
CREATE TRIGGER tomb_sender_identities BEFORE INSERT ON sender_identities FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_sender_identities();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_sender_identities() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_sender_identities ON sender_identities;
CREATE TRIGGER tomb_upd_sender_identities BEFORE UPDATE OF tenant_id ON sender_identities FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_sender_identities();
