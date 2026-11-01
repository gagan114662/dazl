-- #416: privacy-safe audit of preview-claim attempts. Outcome codes only: never an email, IP, token or snapshot.
CREATE TABLE IF NOT EXISTS preview_claim_events (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('claimed','already','claimed_other_workspace','foreign','unverified','expired','unknown')),
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS preview_claim_events_claim ON preview_claim_events (claim_id);
