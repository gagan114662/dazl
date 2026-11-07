-- #916: a CSV batch records its validated per-run budget at creation so every resumed row runs under the same
-- restriction (lib/scan/csv-import.ts). budget_recorded = 0 marks a pre-existing batch whose restriction is unrecoverable;
-- resuming it is refused (the owner re-imports the file), never run unrestricted.
-- Numbered 0050: main's highest is 0049_first_party_withdrawals. Open PRs #192/#600/#610/#612/#616/#619/#620/#642/#934
-- also claim 0050; whichever lands later renumbers (versions must be 1..n with no gaps).
ALTER TABLE csv_batches ADD COLUMN run_budget TEXT CHECK (run_budget IS NULL OR char_length(run_budget) <= 200);

ALTER TABLE csv_batches ADD COLUMN budget_recorded BIGINT NOT NULL DEFAULT 0;
