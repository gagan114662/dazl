-- Numbered 0063 (main's highest is 0062_scan_jobs_fair_claim). Open PRs also claim 0063: renumber to main's highest + 1 at merge (loader needs 1..n, no gaps).
-- #899: the mailbox check's two caps (lib/people/email-pattern.ts verifyCandidates). The per-tenant daily count reads
-- email_candidates by (tenant_id, checked_at); the verifier's monthly free allowance is an operator ledger with no tenant data,
-- so deleting a tenant never frees allowance already spent. SQLite twin: migrateEmailGuess.
CREATE INDEX IF NOT EXISTS email_candidates_tenant_checked ON email_candidates (tenant_id, checked_at);

CREATE TABLE IF NOT EXISTS email_verify_usage (
  verifier TEXT NOT NULL CHECK (char_length(verifier) <= 40),
  month TEXT NOT NULL CHECK (char_length(month) = 7),
  n BIGINT NOT NULL DEFAULT 0 CHECK (n >= 0),
  PRIMARY KEY (verifier, month)
);
