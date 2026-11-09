-- #899 free-first email finder: tiers and pattern confidence. A new migration: 0050 was applied from main and is never edited.

-- Free-first tiers: 'published' = printed on the confirmed site, source_url = that page;
-- 'guessed' = built from the learned pattern, confidence = that pattern's evidence grade. Only 'guessed' + 'high' is
-- ever mailbox-checked. email_patterns keeps the grade, score, runner-up support and the supporting addresses (evidence).
ALTER TABLE email_candidates ADD COLUMN tier TEXT NOT NULL DEFAULT 'guessed' CHECK (tier IN ('published','guessed'));

ALTER TABLE email_candidates ADD COLUMN source_url TEXT CHECK (source_url IS NULL OR char_length(source_url) <= 500);

ALTER TABLE email_candidates ADD COLUMN confidence TEXT CHECK (confidence IS NULL OR confidence IN ('high','medium','low'));

ALTER TABLE email_patterns ADD COLUMN confidence TEXT CHECK (confidence IS NULL OR confidence IN ('high','medium','low'));

ALTER TABLE email_patterns ADD COLUMN score BIGINT CHECK (score IS NULL OR (score >= 0 AND score <= 100));

ALTER TABLE email_patterns ADD COLUMN runner_up BIGINT;

ALTER TABLE email_patterns ADD COLUMN evidence TEXT CHECK (evidence IS NULL OR char_length(evidence) <= 2000);
