-- Provenance-backed technology observations (lib/signals/tech-observations.ts, #389).
CREATE TABLE tech_observations (
    tenant_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    tech TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('present','absent_in_scope')),
    page_url TEXT NOT NULL,
    page_kind TEXT NOT NULL,
    detector_version BIGINT NOT NULL,
    confidence BIGINT NOT NULL CHECK (confidence BETWEEN 0 AND 100),
    matched TEXT,
    observed_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, domain, tech, page_url, observed_at)
  );
CREATE INDEX tech_obs_domain ON tech_observations (tenant_id, domain, tech, observed_at);
