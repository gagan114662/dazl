-- #803 Email conversation state machine for routine buyer questions (lib/replies/conversation.ts, part of #406).
-- buyer_answer_decisions: one row per inbound message, claimed BEFORE any send, so a duplicate delivery, a retry or a
-- concurrent sync never answers twice. No message text is stored (owner decision on #406, 2026-11-04).
-- autopilot_settings.answers_*: the tenant's answer policy, OFF by default; turned on only with the accepted product
-- truth version (setAnswerPolicy).
-- SQLite twins: migrateBuyerAnswers (lib/replies/conversation.ts) and migrateAnswerPolicyColumns (lib/outreach/autopilot.ts).
-- 0062 = main's highest (0061) + 1 (~/work/migration_claims.txt).
ALTER TABLE autopilot_settings ADD COLUMN answers_enabled BIGINT NOT NULL DEFAULT 0 CHECK (answers_enabled IN (0,1));
ALTER TABLE autopilot_settings ADD COLUMN answers_cta TEXT NOT NULL DEFAULT 'signup' CHECK (answers_cta IN ('signup','meeting'));
ALTER TABLE autopilot_settings ADD COLUMN answers_max BIGINT NOT NULL DEFAULT 2 CHECK (answers_max BETWEEN 1 AND 5);
ALTER TABLE autopilot_settings ADD COLUMN answers_facts_version TEXT CHECK (answers_facts_version IS NULL OR char_length(answers_facts_version) <= 40);

CREATE TABLE buyer_answer_decisions (
      tenant_id     TEXT NOT NULL,
      gmail_id      TEXT NOT NULL CHECK (char_length(gmail_id) <= 128),
      thread_id     TEXT NOT NULL CHECK (char_length(thread_id) <= 128),
      action        TEXT NOT NULL CHECK (action IN ('reply','escalate','pause','suppress')),
      reason        TEXT CHECK (reason IS NULL OR char_length(reason) <= 40),
      topics        TEXT CHECK (topics IS NULL OR char_length(topics) <= 120),
      facts_version TEXT CHECK (facts_version IS NULL OR char_length(facts_version) <= 40),
      status        TEXT NOT NULL CHECK (status IN ('recorded','sending','sent','uncertain','held')),
      sent_gmail_id TEXT CHECK (sent_gmail_id IS NULL OR char_length(sent_gmail_id) <= 128),
      created_at    BIGINT NOT NULL,
      updated_at    BIGINT NOT NULL,
      CHECK ((action = 'reply') = (status <> 'recorded')),
      CHECK ((sent_gmail_id IS NOT NULL) = (status = 'sent')),
      PRIMARY KEY (tenant_id, gmail_id)
    );

CREATE INDEX buyer_answer_decisions_thread ON buyer_answer_decisions (tenant_id, thread_id);

CREATE OR REPLACE FUNCTION dazl_guard_tomb_buyer_answer_decisions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_buyer_answer_decisions ON buyer_answer_decisions;
CREATE TRIGGER tomb_buyer_answer_decisions BEFORE INSERT ON buyer_answer_decisions FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_buyer_answer_decisions();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_buyer_answer_decisions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_buyer_answer_decisions ON buyer_answer_decisions;
CREATE TRIGGER tomb_upd_buyer_answer_decisions BEFORE UPDATE OF tenant_id ON buyer_answer_decisions FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_buyer_answer_decisions();
