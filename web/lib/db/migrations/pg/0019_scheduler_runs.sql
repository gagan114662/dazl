-- Scheduler heartbeat and per-tenant progress (lib/ops/scheduler-runs.ts, issue #361): one row per tick run (start,
-- finish, status, lease owner and generation, tenants attempted/failed) and one row per tenant and kind of work (last
-- attempt, last success, last scrubbed failure reason, consecutive failures).
CREATE TABLE scheduler_progress (
      tenant_id            TEXT NOT NULL,
      kind                 TEXT NOT NULL CHECK (kind IN ('reply_sync','followups','sequences')),
      last_attempt_at      BIGINT NOT NULL,
      last_success_at      BIGINT,
      last_error           TEXT CHECK (last_error IS NULL OR char_length(last_error) <= 200),
      consecutive_failures BIGINT NOT NULL DEFAULT 0,
      last_run_id          TEXT,
      PRIMARY KEY (tenant_id, kind)
    );

CREATE TABLE scheduler_runs (
      id                TEXT PRIMARY KEY,
      started_at        BIGINT NOT NULL,
      finished_at       BIGINT,
      status            TEXT NOT NULL CHECK (status IN ('running','ok','partial','failed','lease_lost')),
      lease_owner       TEXT NOT NULL,
      lease_generation  BIGINT NOT NULL,
      tenants_attempted BIGINT NOT NULL DEFAULT 0,
      tenants_failed    BIGINT NOT NULL DEFAULT 0,
      error             TEXT CHECK (error IS NULL OR char_length(error) <= 200)
    );
CREATE INDEX scheduler_runs_started ON scheduler_runs (started_at);
