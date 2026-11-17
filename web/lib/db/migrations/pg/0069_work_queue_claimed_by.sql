-- #836: which instance took each claim of a queue item, so "run once across two workers" can be read from the store.
-- claimed_by: the latest claimer (an instance id), kept after the claim settles. claim_log: the last 8 claims as a JSON
-- list of {attempt, token, by, at}. Both written only by DbQueue.claim (lib/queue/db.ts); nullable, no backfill.
-- Matches the SQLite adapter's columns (lib/queue/sqlite.ts). Number: main's highest + 1 (main ends at 0068_play_alerts.sql).
ALTER TABLE work_queue ADD COLUMN IF NOT EXISTS claimed_by TEXT;
ALTER TABLE work_queue ADD COLUMN IF NOT EXISTS claim_log TEXT;
