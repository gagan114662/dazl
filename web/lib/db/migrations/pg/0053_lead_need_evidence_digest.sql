-- lead_need_evidence.lead_digest: the citation triple (source URL, quote, date) the verdict was recorded from.
-- A verified buying-need read is bound to THAT artifact; any later change reads unproven (#401/#379 same-artifact binding).
ALTER TABLE lead_need_evidence ADD COLUMN IF NOT EXISTS lead_digest TEXT;
