-- #929: content-version binding for a draft's words. Every writer of subject/body (owner edit, sequence rewrite, model polish)
-- bumps words_rev, so a polish or an autopilot approval that started from one revision cannot land on another - including an
-- owner edit that restores the original text (A to B to A), which a text comparison cannot see.
-- Numbered 0050: main's highest is 0049_first_party_withdrawals (provisional; renumbered to main's highest + 1 at gate time).
ALTER TABLE outreach_messages ADD COLUMN words_rev BIGINT NOT NULL DEFAULT 0;
