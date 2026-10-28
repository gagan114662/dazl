-- Insertion order on Postgres (lib/db/insertion-order.ts): SQLite's rowid gave these tables the order same-second ties
-- relied on; insert_seq is that order as a column, filled from a sequence on insert. Existing rows (none in production)
-- are numbered in the order Postgres stores them.

CREATE SEQUENCE IF NOT EXISTS scan_jobs_insert_seq_seq;
ALTER TABLE scan_jobs ADD COLUMN insert_seq BIGINT DEFAULT nextval('scan_jobs_insert_seq_seq');
ALTER SEQUENCE scan_jobs_insert_seq_seq OWNED BY scan_jobs.insert_seq;
CREATE INDEX IF NOT EXISTS scan_jobs_insert_seq_idx ON scan_jobs (insert_seq);

CREATE SEQUENCE IF NOT EXISTS leads_insert_seq_seq;
ALTER TABLE leads ADD COLUMN insert_seq BIGINT DEFAULT nextval('leads_insert_seq_seq');
ALTER SEQUENCE leads_insert_seq_seq OWNED BY leads.insert_seq;
CREATE INDEX IF NOT EXISTS leads_insert_seq_idx ON leads (insert_seq);

CREATE SEQUENCE IF NOT EXISTS outreach_messages_insert_seq_seq;
ALTER TABLE outreach_messages ADD COLUMN insert_seq BIGINT DEFAULT nextval('outreach_messages_insert_seq_seq');
ALTER SEQUENCE outreach_messages_insert_seq_seq OWNED BY outreach_messages.insert_seq;
CREATE INDEX IF NOT EXISTS outreach_messages_insert_seq_idx ON outreach_messages (insert_seq);

CREATE SEQUENCE IF NOT EXISTS lead_enrichments_insert_seq_seq;
ALTER TABLE lead_enrichments ADD COLUMN insert_seq BIGINT DEFAULT nextval('lead_enrichments_insert_seq_seq');
ALTER SEQUENCE lead_enrichments_insert_seq_seq OWNED BY lead_enrichments.insert_seq;
CREATE INDEX IF NOT EXISTS lead_enrichments_insert_seq_idx ON lead_enrichments (insert_seq);
