-- #417: sign-ups and payments of dazl's own acquisition prospects (lib/outreach/lifecycle.ts). acquisition_lifecycle_events is the
-- private event history (one row per event key; a hash of the account email, never the address); acquisition_holds is
-- the durable stop state for one acquisition workspace and one person it emailed. Off unless DAZL_ACQUISITION_TENANTS.
CREATE TABLE acquisition_lifecycle_events (
      event_key   TEXT PRIMARY KEY CHECK (char_length(event_key) <= 200),
      kind        TEXT NOT NULL CHECK (kind IN ('signup_unverified','signup_verified','checkout_unpaid','paid')),
      user_id     TEXT NOT NULL,
      email_hash  TEXT NOT NULL CHECK (char_length(email_hash) = 64),
      received_at BIGINT NOT NULL,
      applied_at  BIGINT
    );
CREATE INDEX acquisition_lifecycle_events_hash ON acquisition_lifecycle_events (email_hash);
CREATE INDEX acquisition_lifecycle_events_pending ON acquisition_lifecycle_events (applied_at);
CREATE TABLE acquisition_holds (
      tenant_id  TEXT NOT NULL,
      email_hash TEXT NOT NULL CHECK (char_length(email_hash) = 64),
      status     TEXT NOT NULL CHECK (status IN ('unverified_signup_hold','checkout_unpaid','signed_up','paid')),
      event_key  TEXT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (tenant_id, email_hash)
    );
