-- #916: a CSV batch records its validated per-run budget at creation so every resumed row runs under the same
-- restriction (lib/scan/csv-import.ts). budget_recorded = 0 marks a pre-existing batch whose restriction is unrecoverable;
-- resuming it is refused (the owner re-imports the file), never run unrestricted.
-- Numbered 0056 = main's highest (0055_crawl_pages) + 1; renumbered from 0050 after main landed 0050_email_verification.
-- Queue: claimed 0057 in the shared migration_claims.txt (#192 holds the 0056 claim); whichever lands second renumbers
-- (versions must be 1..n with no gaps).
ALTER TABLE csv_batches ADD COLUMN run_budget TEXT CHECK (run_budget IS NULL OR char_length(run_budget) <= 200);

ALTER TABLE csv_batches ADD COLUMN budget_recorded BIGINT NOT NULL DEFAULT 0;
