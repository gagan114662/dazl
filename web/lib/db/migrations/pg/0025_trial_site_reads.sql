-- #409: a trial reservation is a scan or a trial-funded website read (lib/billing/trial-budget.ts); a read's settled cost.
ALTER TABLE trial_reservations ADD COLUMN kind TEXT NOT NULL DEFAULT 'scan' CHECK (kind IN ('scan', 'site_read'));
ALTER TABLE trial_reservations ADD COLUMN spent_usd DOUBLE PRECISION CHECK (spent_usd IS NULL OR spent_usd >= 0);
