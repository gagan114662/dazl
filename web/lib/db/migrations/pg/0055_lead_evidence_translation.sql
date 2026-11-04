-- #391: the model's English gloss of a non-English lead quote, stored beside the original (evidence_excerpt) and shown on the lead card as
-- "Translation (not evidence)". Display only: the verifier and every gate read the original quote. Existing rows keep NULL (no backfill: a
-- gloss that was never stored is not invented later). Queue slot 0055 (handoffs/migration-queue.md, after #633's 0047 landed):
-- contiguous on main once the PRs before it land; draft until then.
ALTER TABLE leads ADD COLUMN evidence_translation TEXT CHECK (evidence_translation IS NULL OR char_length(evidence_translation) <= 400);
