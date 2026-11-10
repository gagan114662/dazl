-- #929: content-version binding for a draft's words. Every writer of subject/body (owner edit, sequence rewrite, model polish)
-- bumps words_rev (the trigger below refuses any subject/body change that does not), so a polish or an autopilot approval that started from one revision cannot land on another - including an
-- owner edit that restores the original text (A to B to A), which a text comparison cannot see.
-- Numbered 0060 = main's highest (0059_adv_request_budget) + 1 (renumbered from 0050 after main landed 0050..0059; claimed in the shared migration queue 2026-11-10).
ALTER TABLE outreach_messages ADD COLUMN words_rev BIGINT NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION dazl_guard_outreach_words_need_rev() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ((NEW.subject IS DISTINCT FROM OLD.subject OR NEW.body IS DISTINCT FROM OLD.body) AND NEW.words_rev = OLD.words_rev) THEN RAISE EXCEPTION 'words_rev not bumped'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS outreach_words_need_rev ON outreach_messages;
CREATE TRIGGER outreach_words_need_rev BEFORE UPDATE OF subject, body ON outreach_messages FOR EACH ROW EXECUTE FUNCTION dazl_guard_outreach_words_need_rev();
