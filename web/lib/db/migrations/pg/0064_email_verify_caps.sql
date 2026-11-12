-- #899: indexes for the two mailbox-check cap counts in lib/people/email-pattern.ts verifyCandidates: per tenant per UTC day,
-- and per verifier account per UTC month (the free allowance). SQLite twin: migrateEmailGuess.
CREATE INDEX IF NOT EXISTS email_candidates_tenant_checked ON email_candidates (tenant_id, checked_at);

CREATE INDEX IF NOT EXISTS email_candidates_verifier_checked ON email_candidates (verifier, checked_at);
