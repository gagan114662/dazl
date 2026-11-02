-- #417: prospect lifecycle conversion events (lib/outreach/lifecycle.ts). Global by design: keyed by verified
-- account email (kind|email); account_tenant is attribution only. activated_at NULL = pending (unverified).
CREATE TABLE lifecycle_events (
  event_key      TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('signup','activation','payment')),
  email          TEXT NOT NULL,
  account_tenant TEXT,
  created_at     BIGINT NOT NULL,
  activated_at   BIGINT
);

CREATE INDEX lifecycle_events_email ON lifecycle_events (email);
