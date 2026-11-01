-- Auto-enrolled cold follow-up sequences (#414): policy version + claims hash on the sequence, and the
-- tenant's one-time acceptance of AUTO_SEQUENCE_POLICY on sequence_settings. NULL policy = the pre-#414
-- manual kind, untouched by the auto guard. Nullable adds only; existing rows stay manual.
ALTER TABLE sequences ADD COLUMN policy TEXT;
ALTER TABLE sequences ADD COLUMN claims_hash TEXT;
ALTER TABLE sequence_settings ADD COLUMN auto_policy TEXT;
ALTER TABLE sequence_settings ADD COLUMN auto_policy_at BIGINT;
