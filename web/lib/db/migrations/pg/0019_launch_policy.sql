-- A calibrated launch's accepted policy (lib/outreach/launch-policy.ts, #405): one row per tenant, the policy JSON at
-- its version, when it was accepted, and when a passing preflight launched it (NULL until then; a new acceptance clears it).
-- 0019: the next number after main's 0018_scan_estimate. #444 (0019_trial_site_reads) and #448 (0018_autopilot_work) also
-- need a number; migrations must be gap-free, so whichever merges after another renumbers to the next free one.
CREATE TABLE autopilot_launch_policy (
    tenant_id TEXT PRIMARY KEY, version TEXT NOT NULL CHECK (char_length(version) <= 20),
    policy TEXT NOT NULL CHECK (char_length(policy) <= 8000), accepted_at BIGINT NOT NULL, launched_at BIGINT,
    preflight TEXT CHECK (preflight IS NULL OR char_length(preflight) <= 4000)
  );
