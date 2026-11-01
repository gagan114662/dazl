-- Explicit seller Add/Dismiss history. No legacy review-status backfill or automatic deletion.
CREATE TABLE seller_decisions (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL, job_id TEXT NOT NULL,
 site TEXT NOT NULL, offer_id TEXT NOT NULL, hypothesis_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK (kind IN ('persona','industry','size','location','disqualifier','pain')),
 text TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('confirm','reject')),
 source_url TEXT, source_quote TEXT, source_checked_at BIGINT,
 created_at BIGINT NOT NULL, version BIGINT NOT NULL CHECK (version = 1),
 UNIQUE(tenant_id,job_id,offer_id,hypothesis_id)
); CREATE INDEX seller_decisions_recall ON seller_decisions(tenant_id,site,created_at,id);
