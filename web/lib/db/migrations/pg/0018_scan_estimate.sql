-- The price estimate shown when a scan was confirmed (lib/scan/price-estimate.ts): JSON with the total range, rows, payer and cap. NULL for scans started before estimates existed.
ALTER TABLE scan_jobs ADD COLUMN estimate TEXT;
