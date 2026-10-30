-- Discovery rounds (lib/scan/discovery-rounds.ts, #381): one row per query tried in an adaptive round, so a failed or empty query is never paid for twice and a stop reason can be told from market exhaustion.
CREATE TABLE discovery_rounds (
    job_id TEXT NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
    round BIGINT NOT NULL,
    source TEXT NOT NULL,
    query_key TEXT NOT NULL,
    query TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('ok','empty','failed')),
    new_pages BIGINT NOT NULL DEFAULT 0,
    actionable_after BIGINT NOT NULL DEFAULT 0,
    why TEXT,
    at BIGINT NOT NULL DEFAULT (CAST(floor(extract(epoch from now())) AS BIGINT)),
    PRIMARY KEY (job_id, round, source, query_key)
  );
