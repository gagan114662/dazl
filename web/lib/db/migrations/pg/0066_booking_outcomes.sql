-- #367: Cal.com booking outcomes (lib/calcom/index.ts). Additive columns only: every existing booking row reads as
-- 'scheduled' with unknown meeting time, which is what it was (only BOOKING_CREATED was recorded before). The row is
-- the booking's history; events merge into it order-independently, and `held` comes only from the audited manual
-- reconciliation. Number: main's highest + 1 (main ends at 0065_monitor_runs_job.sql, PR #1132), per migration_claims.txt.
-- The (tenant_id, lead_id) index serves every lead-keyed read of the outcome logic: standing(), syncStage's
-- remembered-stage lookups and clearing UPDATE, and lib/outreach/conversion.ts's correlated EXISTS per sent message;
-- booking_uid last so the remembered-stage lookup (ORDER BY booking_uid LIMIT 1) reads it in order, no sort.
ALTER TABLE calcom_bookings ADD COLUMN status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'ended', 'held', 'no_show', 'cancelled', 'rescheduled'));
ALTER TABLE calcom_bookings ADD COLUMN start_at BIGINT;
ALTER TABLE calcom_bookings ADD COLUMN end_at BIGINT;
ALTER TABLE calcom_bookings ADD COLUMN ical_uid TEXT;
ALTER TABLE calcom_bookings ADD COLUMN ical_seq BIGINT;
ALTER TABLE calcom_bookings ADD COLUMN detail_ms BIGINT;
ALTER TABLE calcom_bookings ADD COLUMN attendees TEXT;
ALTER TABLE calcom_bookings ADD COLUMN cancelled_ms BIGINT;
ALTER TABLE calcom_bookings ADD COLUMN rescheduled_to TEXT;
ALTER TABLE calcom_bookings ADD COLUMN rescheduled_from TEXT;
ALTER TABLE calcom_bookings ADD COLUMN ended_at BIGINT;
ALTER TABLE calcom_bookings ADD COLUMN no_show_marks TEXT;
ALTER TABLE calcom_bookings ADD COLUMN manual_outcome TEXT CHECK (manual_outcome IS NULL OR manual_outcome IN ('held', 'no_show', 'cancelled'));
ALTER TABLE calcom_bookings ADD COLUMN manual_at BIGINT;
ALTER TABLE calcom_bookings ADD COLUMN manual_by TEXT;
ALTER TABLE calcom_bookings ADD COLUMN last_event_ms BIGINT;
ALTER TABLE calcom_bookings ADD COLUMN lead_prev_stage TEXT;
CREATE INDEX IF NOT EXISTS calcom_bookings_tenant_lead ON calcom_bookings (tenant_id, lead_id, booking_uid);
