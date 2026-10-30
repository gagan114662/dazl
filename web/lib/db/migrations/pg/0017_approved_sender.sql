-- The Gmail address an approval was given for (lib/outreach/service.ts, lib/outreach/sequences.ts, #370). Another sender
-- never sends an approved email or sequence step: it goes back to draft for a person to approve again.
ALTER TABLE outreach_messages ADD COLUMN approved_sender TEXT;
ALTER TABLE sequence_steps ADD COLUMN approved_sender TEXT;
