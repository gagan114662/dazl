-- #416: signed expiring preview claims. One row per issued claim; the binding (run, seller, recipient, expiry) is
-- immutable after insert. claimed_* are set once, atomically, by the claiming workspace. Served by token only.
CREATE TABLE IF NOT EXISTS preview_claims (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  seller_tenant_id TEXT NOT NULL,
  recipient_email TEXT NOT NULL CHECK (char_length(recipient_email) <= 254),
  business TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  claimed_by_tenant TEXT,
  claimed_at BIGINT
);
CREATE INDEX IF NOT EXISTS preview_claims_recipient ON preview_claims (recipient_email);
