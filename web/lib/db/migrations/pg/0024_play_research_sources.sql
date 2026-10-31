-- Supplemental research keyed to an existing finished play. Not leads, scan results or email recipients.
CREATE TABLE play_research_sources (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, job_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
 input_json TEXT NOT NULL, query_snapshot TEXT NOT NULL, offer_snapshot TEXT NOT NULL,
 play_created_at BIGINT NOT NULL, icp_snapshot TEXT, offer_source TEXT NOT NULL,
 source_check TEXT NOT NULL, person_check TEXT, created_at BIGINT NOT NULL,
 UNIQUE(tenant_id,job_id,fingerprint)
);
CREATE INDEX play_research_sources_play ON play_research_sources(tenant_id,job_id,created_at);
