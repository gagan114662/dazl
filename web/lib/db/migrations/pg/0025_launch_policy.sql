-- A calibrated launch's accepted policy (lib/outreach/launch-policy.ts, #405): one row per tenant, the policy JSON at
-- its version, when it was accepted, and when a passing preflight launched it (NULL until then; a new acceptance clears it).
-- acceptance_id identifies one acceptance: a calibration records its result only against the acceptance it started for.
-- 0025: the next number after main's 0024_play_research_sources. Provisional; renumbered to the next available number
-- after the predecessors land (migrations must be gap-free: the loader refuses a gap, so no number is reserved).
CREATE TABLE autopilot_launch_policy (
    tenant_id TEXT PRIMARY KEY, acceptance_id TEXT NOT NULL CHECK (char_length(acceptance_id) = 16),
    version TEXT NOT NULL CHECK (char_length(version) <= 20),
    policy TEXT NOT NULL CHECK (char_length(policy) <= 8000), accepted_at BIGINT NOT NULL, launched_at BIGINT,
    preflight TEXT CHECK (preflight IS NULL OR char_length(preflight) <= 4000)
  );
