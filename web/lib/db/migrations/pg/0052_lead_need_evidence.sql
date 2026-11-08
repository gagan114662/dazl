-- #401/#379 buying-need evidence (lib/scan/need-evidence.ts): one persisted verdict per (tenant, lead), written only
-- by a new search's own write stage and believed by the reader only while every binding (offer, window, qualifier
-- version, plan semantics, classifier re-read, domain) still holds. SQLite twin: migrateNeedEvidence.

CREATE TABLE lead_need_evidence (
    tenant_id         TEXT NOT NULL,
    job_id            TEXT NOT NULL,
    lead_id           TEXT NOT NULL,
    basis             TEXT NOT NULL CHECK (basis IN ('demand_post', 'hiring_trigger', 'none')),
    verdict           TEXT NOT NULL CHECK (verdict IN ('verified_buying_need', 'needs_evidence', 'trigger_only', 'excluded', 'unqualifiable', 'unproven')),
    reason            TEXT CHECK (reason IS NULL OR char_length(reason) <= 200),
    qualifier_version TEXT,
    offer             TEXT,
    window_days       BIGINT,
    rubric_reason     TEXT CHECK (rubric_reason IS NULL OR char_length(rubric_reason) <= 60),
    demand_class      TEXT,
    demand_tier       TEXT,
    scores            TEXT,
    families          TEXT,
    reasons           TEXT,
    missing           TEXT,
    requester         TEXT,
    mentioned_orgs    TEXT,
    source_url        TEXT,
    source_title      TEXT,
    source_text       TEXT,
    author_name       TEXT,
    author_headline   TEXT,
    author_company    TEXT,
    published_at      TEXT,
    plan_support      TEXT NOT NULL,
    created_at        BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, lead_id)
  );

CREATE INDEX lead_need_evidence_job ON lead_need_evidence (tenant_id, job_id);
