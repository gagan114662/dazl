-- Cal.com booking lifecycle (lib/calcom/index.ts, #367): status, times, every attendee, the booking a reschedule
-- replaced, and meeting outcomes (held / no-show, from Cal.com or marked by a person, with who and when). Every booking
-- event is kept in calcom_booking_events; a replayed event is a duplicate.
ALTER TABLE calcom_bookings ADD COLUMN status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled', 'rescheduled'));
ALTER TABLE calcom_bookings ADD COLUMN start_at BIGINT;
ALTER TABLE calcom_bookings ADD COLUMN end_at BIGINT;
ALTER TABLE calcom_bookings ADD COLUMN event_at BIGINT;
ALTER TABLE calcom_bookings ADD COLUMN rescheduled_from TEXT;
ALTER TABLE calcom_bookings ADD COLUMN attendees TEXT;
ALTER TABLE calcom_bookings ADD COLUMN cancelled_at BIGINT;
ALTER TABLE calcom_bookings ADD COLUMN outcome TEXT CHECK (outcome IS NULL OR outcome IN ('held', 'no_show'));
ALTER TABLE calcom_bookings ADD COLUMN outcome_source TEXT CHECK (outcome_source IS NULL OR outcome_source IN ('calcom', 'manual'));
ALTER TABLE calcom_bookings ADD COLUMN outcome_by TEXT;
ALTER TABLE calcom_bookings ADD COLUMN outcome_at BIGINT;
CREATE TABLE calcom_booking_events (
  tenant_id   TEXT NOT NULL,
  booking_uid TEXT NOT NULL,
  kind        TEXT NOT NULL,
  event_key   TEXT NOT NULL,
  event_at    BIGINT,
  actor       TEXT,
  detail      TEXT,
  received_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, booking_uid, kind, event_key)
);
