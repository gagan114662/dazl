-- Enrichment stage marks (lib/scan/enrichment.ts): set while contacts / people / fit are still being added after the rows are written.
ALTER TABLE scan_jobs ADD COLUMN enrich_started_at BIGINT;
ALTER TABLE scan_jobs ADD COLUMN enrich_finished_at BIGINT;
