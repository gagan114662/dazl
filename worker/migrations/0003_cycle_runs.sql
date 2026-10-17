-- Cron dedupe ledger (additive).
--
-- The hourly cron starts one EmployeeCycle per employee per firing. A re-run
-- within the same clock hour (manual re-trigger, scheduler retry) must not
-- start a second billed cycle for the same employee. Relying on the
-- Workflows runtime to reject a duplicate instance id does NOT work (verified
-- empirically: a second create() with the same id neither throws nor is
-- observable as a no-op), so the claim lives here in D1, where an
-- INSERT OR IGNORE gives a deterministic, testable once-per-hour guarantee.
CREATE TABLE IF NOT EXISTS cycle_runs (
  tenant_id     TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  hour_bucket   INTEGER NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (tenant_id, employee_name, hour_bucket)
);
