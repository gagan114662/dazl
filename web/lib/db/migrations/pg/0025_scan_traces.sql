-- Captured production scan traces (lib/evals/capture.ts, docs/design/agent-evals.md "Production capture"): one redacted
-- trace per captured run attempt, tenant-scoped, deleted after DAZL_TRACE_RETENTION_DAYS (default 14). Capture is OFF
-- unless DAZL_TRACE_CAPTURE=1. The next unused number after 0024_play_research_sources on main b8db51a4; re-checked (and renamed if #448 lands first) at merge time.
CREATE TABLE scan_traces (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      attempt BIGINT NOT NULL,
      created_at BIGINT NOT NULL,
      bytes BIGINT NOT NULL,
      trace TEXT NOT NULL
    );
CREATE INDEX scan_traces_created ON scan_traces (created_at);
CREATE INDEX scan_traces_tenant ON scan_traces (tenant_id, created_at);
