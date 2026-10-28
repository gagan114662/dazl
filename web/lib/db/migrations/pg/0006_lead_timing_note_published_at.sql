-- Page timing on a lead (lib/scan/page-timing.ts): the page's publication day is a label (published_at), never the event date;
-- timing_note says how a missing date was resolved or carries a season label with no date.
ALTER TABLE leads ADD COLUMN timing_note TEXT CHECK (timing_note IS NULL OR char_length(timing_note) <= 300);
ALTER TABLE leads ADD COLUMN published_at TEXT;
