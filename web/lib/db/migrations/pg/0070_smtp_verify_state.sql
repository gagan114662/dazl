-- Numbered 0070: main's highest is 0069_work_queue_claimed_by (session E landed 0069 first).
-- #1036: dazl's own SMTP mailbox check (lib/people/smtp-verify.ts). One operator ledger, no tenant data and no addresses of people:
--   dom:<domain>        per-domain facts (preferred MX, catch-all answer) kept 30 days
--   rcpt:<mx>:<hour>    RCPT commands sent to one MX host in one UTC hour (the hourly limit)
--   bo:<mx>             backoff after a 4xx (n = failures in a row, hold_until = when the host may be contacted again)
--   zen:<ip>            the daily Spamhaus ZEN answer for the sending IP (the circuit breaker)
-- SQLite twin: migrateSmtpVerify.
CREATE TABLE IF NOT EXISTS smtp_verify_state (
  k TEXT PRIMARY KEY CHECK (char_length(k) <= 300),
  n BIGINT NOT NULL DEFAULT 0,
  hold_until BIGINT NOT NULL DEFAULT 0,
  v TEXT CHECK (v IS NULL OR char_length(v) <= 500),
  updated_at BIGINT NOT NULL DEFAULT (CAST(floor(extract(epoch from now())) AS BIGINT))
);
