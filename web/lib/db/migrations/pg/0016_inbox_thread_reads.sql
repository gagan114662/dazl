-- Inbox read state (lib/outreach/inbox.ts, #369): the newest reply time the owner has seen in each thread, and the index
-- the per-thread inbox query reads replies through.
CREATE TABLE inbox_thread_reads (tenant_id TEXT NOT NULL, thread_id TEXT NOT NULL, read_upto BIGINT NOT NULL, PRIMARY KEY (tenant_id, thread_id));
CREATE INDEX inbound_messages_thread ON inbound_messages (tenant_id, thread_id, received_at);
