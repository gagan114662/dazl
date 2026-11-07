-- #899: email finder parts 2-3 (lib/people/email-pattern.ts). status stays 'unverified' (a candidate is never a contact);
-- verification is the mailbox-check outcome, verifier / checked_at its provenance, country_basis the US evidence the
-- candidate was recorded on. Additive columns on an existing table: no new table, so no new tomb guard (0039).
-- Numbered 0050: main's highest is 0049_first_party_withdrawals (placeholder - reassigned to main's highest + 1 at merge).
ALTER TABLE email_candidates ADD COLUMN verification TEXT NOT NULL DEFAULT 'none' CHECK (verification IN ('none','pending','verified','catch_all','undeliverable','uncertain','refused'));

ALTER TABLE email_candidates ADD COLUMN verifier TEXT CHECK (verifier IS NULL OR char_length(verifier) <= 40);

ALTER TABLE email_candidates ADD COLUMN checked_at BIGINT;

ALTER TABLE email_candidates ADD COLUMN country_basis TEXT CHECK (country_basis IS NULL OR char_length(country_basis) <= 160);
