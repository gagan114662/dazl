-- #1040: Home's 30-day results (lib/outreach/home-results.ts). Additive indexes only, matching the SQLite migrate*()
-- functions (lib/outreach/store.ts, lib/outreach/replies.ts): the tenant's messages sent since a date, the tenant's
-- replies received since a date, a scan's leads found since a date, and a reply's sent message (per-message attribution, so the by-signal reply counts add
-- up to the Replied tile). Number: main's highest + 1 (main ends at 0066_booking_outcomes.sql).
CREATE INDEX IF NOT EXISTS outreach_messages_tenant_sent ON outreach_messages (tenant_id, sent_at);
CREATE INDEX IF NOT EXISTS inbound_messages_tenant_received ON inbound_messages (tenant_id, received_at);
CREATE INDEX IF NOT EXISTS inbound_messages_outreach ON inbound_messages (tenant_id, outreach_message_id);
CREATE INDEX IF NOT EXISTS leads_job_created ON leads (scan_job_id, created_at);
