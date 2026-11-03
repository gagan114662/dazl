-- First-touch backlog drain (#411) is its own per-tenant kind of scheduled work: per-tenant freshness and the
-- operator view must see its failures and holds like any other kind. Only the kind CHECK widens; rows are untouched.
ALTER TABLE scheduler_progress DROP CONSTRAINT IF EXISTS scheduler_progress_kind_check;
ALTER TABLE scheduler_progress ADD CONSTRAINT scheduler_progress_kind_check CHECK (kind IN ('reply_sync','followups','sequences','first_touch'));
