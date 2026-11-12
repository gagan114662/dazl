-- #1081 fair scan claiming (lib/scan/runner.ts claimKeyedJob): each tenant's last claim and last finish, and the jobs
-- still in post-finish enrichment, are index seeks. SQLite twin: migrateScan (lib/scan/store.ts).
-- 0064: main's highest is 0061; open PRs hold 0062 (#1073) and 0063 (#1076).
CREATE INDEX scan_jobs_enriching ON scan_jobs (enrich_started_at) WHERE enrich_finished_at IS NULL;
CREATE INDEX scan_jobs_user_claimed ON scan_jobs (user_id, claimed_at);
CREATE INDEX scan_jobs_user_finished ON scan_jobs (user_id, finished_at);
