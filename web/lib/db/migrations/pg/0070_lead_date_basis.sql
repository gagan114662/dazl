-- #1099: a lead's event_date can be the ANNOUNCEMENT's day (the publication day of the page announcing a completed event), labelled so its copy says
-- "announced <date>", never "happened on <date>". SQLite: lib/scan/store.ts addColumns.
ALTER TABLE leads ADD COLUMN date_basis TEXT CHECK (date_basis IS NULL OR date_basis IN ('announcement_dateline'));
