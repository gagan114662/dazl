-- #381 adaptive discovery (lib/scan/runner.ts isMonitorRun): the runner asks whether a zero-verified job is a monitor's run
-- before it spends on one more search round. That lookup is by job_id, which had no index (a full scan of every tenant's
-- runs). SQLite twin: migrateMonitors (lib/monitors.ts). 0064 = main's highest (0063_email_verify_caps, #1119) + 1;
-- versions must be contiguous (migrate-pg.ts), so whichever open PR merges later renumbers to the next free number.
CREATE INDEX monitor_runs_job ON monitor_runs (job_id);
