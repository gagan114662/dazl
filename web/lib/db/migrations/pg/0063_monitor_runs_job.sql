-- #381 adaptive discovery (lib/scan/runner.ts): the runner asks whether a zero-verified job is a monitor's run before it
-- spends on one more search round. That lookup is by job_id, which had no index (a full scan of every tenant's runs).
-- SQLite twin: migrateMonitors (lib/monitors.ts). 0063 = main's highest (0062) + 1; claimed in the migration queue behind
-- open PRs #1073, #1076 and #1119, so whichever merges later renumbers to the next free number.
CREATE INDEX monitor_runs_job ON monitor_runs (job_id);
