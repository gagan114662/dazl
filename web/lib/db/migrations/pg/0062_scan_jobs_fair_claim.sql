-- #1081 fair scan claiming (lib/scan/runner.ts claimKeyedJob): each tenant's last claim and last finish, and the jobs
-- still in post-finish enrichment, are index seeks. SQLite twin: migrateScan (lib/scan/store.ts).
-- 0062 = main's highest (0061) + 1. Versions must be contiguous (migrate-pg.ts), so open PR #1073 also uses 0062 and
-- #1076 0063: whichever merges later renumbers to the next free number.
CREATE INDEX scan_jobs_enriching ON scan_jobs (enrich_started_at) WHERE enrich_finished_at IS NULL;
CREATE INDEX scan_jobs_user_claimed ON scan_jobs (user_id, claimed_at);
CREATE INDEX scan_jobs_user_finished ON scan_jobs (user_id, finished_at);
