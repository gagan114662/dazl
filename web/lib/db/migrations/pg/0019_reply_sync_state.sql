-- Scheduled reply reading (lib/outreach/reply-schedule.ts, #413): one checkpoint per tenant - when replies were last read,
-- whether that sync succeeded (a failed or partial sync is never fresh), and whether bounce notices were covered.
CREATE TABLE reply_sync_state (
      tenant_id TEXT PRIMARY KEY,
      checked_at BIGINT NOT NULL,
      ok BIGINT NOT NULL CHECK (ok IN (0, 1)),
      error TEXT CHECK (error IS NULL OR char_length(error) <= 60),
      bounce_coverage TEXT NOT NULL DEFAULT 'unknown' CHECK (bounce_coverage IN ('checked', 'unknown')),
      last_ok_at BIGINT
    );
