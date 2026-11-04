-- #406: the routine buyer-answer ledger (lib/replies/answer-ledger.ts). One row per inbound message of a dazl outreach
-- thread the planner has seen: the decision (outcome, reason), the answer dazl wrote from the accepted product truth
-- record (never the inbound text), the mailbox's own authentication verdict line, and the send state. (tenant_id,
-- message_id) is the send-once key; an answer leaves only through the ready -> sending compare-and-set. No reply body is
-- stored: detail is a bounded label (at most 200 characters, the reading consent's excerpt bound). Tomb guards per 0039.
-- Numbered main's highest + 1 (0050) on the rebased branch; if another migration lands first, renumber to main's
-- then-highest + 1 at the merge gate and regenerate the schema pins in the same push.
CREATE TABLE buyer_answers (
    tenant_id TEXT NOT NULL,
    message_id TEXT NOT NULL CHECK (char_length(message_id) BETWEEN 1 AND 200),
    thread_id TEXT NOT NULL,
    lead_id TEXT,
    outreach_message_id TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('suppressed','paused','exception','approval','send','held','off')),
    reason TEXT CHECK (reason IS NULL OR char_length(reason) <= 40),
    detail TEXT CHECK (detail IS NULL OR char_length(detail) <= 200),
    topics TEXT CHECK (topics IS NULL OR char_length(topics) <= 200),
    facts_version TEXT CHECK (facts_version IS NULL OR char_length(facts_version) <= 40),
    cta TEXT CHECK (cta IS NULL OR cta IN ('signup','meeting')),
    body TEXT CHECK (body IS NULL OR char_length(body) <= 4000),
    auth TEXT NOT NULL CHECK (auth IN ('pass','fail')),
    auth_verdict TEXT CHECK (auth_verdict IS NULL OR char_length(auth_verdict) <= 300),
    status TEXT NOT NULL CHECK (status IN ('recorded','ready','sending','sent','uncertain','cancelled')),
    sent_gmail_id TEXT,
    claimed_at BIGINT,
    released_at BIGINT,
    resolved_at BIGINT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, message_id)
  );

CREATE INDEX buyer_answers_status ON buyer_answers (tenant_id, status);

CREATE INDEX buyer_answers_thread ON buyer_answers (tenant_id, thread_id);

CREATE OR REPLACE FUNCTION dazl_guard_tomb_buyer_answers() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_buyer_answers ON buyer_answers;
CREATE TRIGGER tomb_buyer_answers BEFORE INSERT ON buyer_answers FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_buyer_answers();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_buyer_answers() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_buyer_answers ON buyer_answers;
CREATE TRIGGER tomb_upd_buyer_answers BEFORE UPDATE OF tenant_id ON buyer_answers FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_buyer_answers();
