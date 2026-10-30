-- Reply-read checkpoint (lib/outreach/replies.ts, #355): when each sent message's thread was last read in full. A bounded
-- sync reads the threads that can still trigger a send first, then the least recently read; a send waits for a fresh read.
CREATE TABLE reply_sync_checks (tenant_id TEXT NOT NULL, message_id TEXT NOT NULL, thread_id TEXT, checked_at BIGINT NOT NULL, PRIMARY KEY (tenant_id, message_id));
