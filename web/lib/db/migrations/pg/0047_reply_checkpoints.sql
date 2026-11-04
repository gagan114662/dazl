-- #355: bounded, checkpointed reply reading (lib/outreach/replies.ts syncReplies). The last time a sent message's
-- thread was read and processed without error; NULL = never read. Nullable, no default: existing rows keep NULL and
-- are read first (never-read first), so no data changes and no backfill is needed.
ALTER TABLE outreach_messages ADD COLUMN reply_checked_at BIGINT;
