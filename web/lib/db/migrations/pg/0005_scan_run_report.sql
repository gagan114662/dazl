-- Per-attempt run report of a scan (lib/scan/run-report.ts): the whole-attempt record of queries, sources, verification outcomes and model use.
CREATE TABLE scan_run_report (
    job_id TEXT NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
    attempt BIGINT NOT NULL,
    report TEXT NOT NULL CHECK (char_length(report) <= 120000),
    created_at BIGINT NOT NULL DEFAULT (CAST(floor(extract(epoch from now())) AS BIGINT)),
    PRIMARY KEY (job_id, attempt)
  );
