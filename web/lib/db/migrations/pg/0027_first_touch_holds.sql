-- First-touch hold bookkeeping (#411): the scheduler stamps why a first-touch draft is held, when it may retry,
-- under which consent version the hold was recorded, and the offer hash the words were created under. Nullable
-- columns only; existing rows keep NULL (never scheduler-held), so no data changes.
ALTER TABLE outreach_messages ADD COLUMN hold_reason TEXT;
ALTER TABLE outreach_messages ADD COLUMN hold_until BIGINT;
ALTER TABLE outreach_messages ADD COLUMN hold_policy TEXT;
ALTER TABLE outreach_messages ADD COLUMN offer_hash TEXT;
