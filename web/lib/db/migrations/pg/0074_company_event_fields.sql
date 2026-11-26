-- #1592: a company event's own kind and its funding amount on the lead row. NULL on every non-event lead;
-- the amount is kept only when the proof page prints it (lib/discover/check.ts amountOnPage).
ALTER TABLE leads ADD COLUMN event_kind TEXT CHECK (event_kind IS NULL OR event_kind IN ('funding','expansion','launch','contract','other'));
ALTER TABLE leads ADD COLUMN event_amount TEXT CHECK (event_amount IS NULL OR char_length(event_amount) <= 60);
