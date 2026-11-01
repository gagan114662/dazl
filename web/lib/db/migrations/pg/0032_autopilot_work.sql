-- First touches autopilot drafted but could not send yet (lib/outreach/autopilot.ts, #411): why, when they may go next
-- (NULL = the user decides), and the authority (words, recipient, sender, offer, consent) they were drafted under.
CREATE TABLE autopilot_work (
      message_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      lead_id TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (char_length(reason) <= 40),
      next_at BIGINT,
      authority TEXT NOT NULL,
      attempts BIGINT NOT NULL DEFAULT 0,
      claimed_at BIGINT,
      created_at BIGINT NOT NULL DEFAULT (CAST(floor(extract(epoch from now())) AS BIGINT))
    );
CREATE INDEX autopilot_work_due ON autopilot_work (tenant_id, next_at);
-- The new-lead query checks each candidate lead's skipped audit rows, and a send's commitment reads the tenant's disables.
CREATE INDEX autopilot_audit_lead ON autopilot_audit (tenant_id, lead_id, action);
CREATE INDEX autopilot_audit_action ON autopilot_audit (tenant_id, action);
