-- #367: Cal.com booking outcomes (lib/calcom/index.ts). Additive columns only: every existing booking row reads as
-- 'scheduled' with unknown meeting time, which is what it was (only BOOKING_CREATED was recorded before). The row is
-- the booking's history; events merge into it order-independently, and `held` comes only from the audited manual
-- reconciliation. Number claimed in migration_claims.txt (PC + Mac): 0044 is #596, 0045/0046 are claimed by other lanes.
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
