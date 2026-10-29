-- Per tenant, the last reply sync and the last one that read every thread (lib/outreach/replies.ts, #413). A sync with
-- any failure leaves ok_at as it was, so freshness reads as unknown and no send relies on a partial read.
CREATE TABLE reply_sync_state (
    tenant_id TEXT PRIMARY KEY,
    checked_at BIGINT NOT NULL,
    ok_at BIGINT,
    error TEXT CHECK (error IS NULL OR char_length(error) <= 40),
    failed_threads BIGINT NOT NULL DEFAULT 0
  );
