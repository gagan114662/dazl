-- #899: email finder parts 2-3 (lib/people/email-pattern.ts). status stays 'unverified' (a candidate is never a contact);
-- verification is the mailbox-check outcome, verifier / checked_at its provenance, country_basis the US evidence the
-- candidate was recorded on. Additive columns on an existing table: no new table, so no new tomb guard (0039).
-- Numbered 0050: main's highest is 0049_first_party_withdrawals (placeholder - reassigned to main's highest + 1 at merge).
ALTER TABLE email_candidates ADD COLUMN verification TEXT NOT NULL DEFAULT 'none' CHECK (verification IN ('none','pending','verified','catch_all','undeliverable','uncertain','refused'));

ALTER TABLE email_candidates ADD COLUMN verifier TEXT CHECK (verifier IS NULL OR char_length(verifier) <= 40);

ALTER TABLE email_candidates ADD COLUMN checked_at BIGINT;

ALTER TABLE email_candidates ADD COLUMN country_basis TEXT CHECK (country_basis IS NULL OR char_length(country_basis) <= 160);

-- Free-first tiers (owner direction 2026-11-06): 'published' = printed on the confirmed site, source_url = that page;
-- 'guessed' = built from the learned pattern, confidence = that pattern's evidence grade. Only 'guessed' + 'high' is
-- ever mailbox-checked. email_patterns keeps the grade, score, runner-up support and the supporting addresses (evidence).
ALTER TABLE email_candidates ADD COLUMN tier TEXT NOT NULL DEFAULT 'guessed' CHECK (tier IN ('published','guessed'));

ALTER TABLE email_candidates ADD COLUMN source_url TEXT CHECK (source_url IS NULL OR char_length(source_url) <= 500);

ALTER TABLE email_candidates ADD COLUMN confidence TEXT CHECK (confidence IS NULL OR confidence IN ('high','medium','low'));

ALTER TABLE email_patterns ADD COLUMN confidence TEXT CHECK (confidence IS NULL OR confidence IN ('high','medium','low'));

ALTER TABLE email_patterns ADD COLUMN score BIGINT CHECK (score IS NULL OR (score >= 0 AND score <= 100));

ALTER TABLE email_patterns ADD COLUMN runner_up BIGINT;

ALTER TABLE email_patterns ADD COLUMN evidence TEXT CHECK (evidence IS NULL OR char_length(evidence) <= 2000);
