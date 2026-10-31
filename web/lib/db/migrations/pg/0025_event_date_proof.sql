-- Event-date proof (#460): how a surviving leads.event_date was established. page_bound: the fetched page or its held
-- copy ties the day to this company and event. ats_structured: a job board's own structured publish date for exactly
-- this posting URL (a hiring posting day only, never funding or a general company event). NULL: unproven - consumers
-- fail closed. No backfill: rows written before this column stay unproven.
ALTER TABLE leads ADD COLUMN event_date_proof TEXT CHECK (event_date_proof IS NULL OR event_date_proof IN ('page_bound','ats_structured'));
ALTER TABLE leads ADD COLUMN event_date_proof_note TEXT CHECK (event_date_proof_note IS NULL OR length(event_date_proof_note) <= 200);
