-- #391: the model's English gloss of a non-English lead quote, stored beside the original (evidence_excerpt) and shown on the lead card as
-- "Translation (not evidence)". Display only: the verifier and every gate read the original quote. Existing rows keep NULL (no backfill: a
-- gloss that was never stored is not invented later). Numbered main's highest + 1 (0050) at this rebase; reassigned to then-current main's highest + 1 at the merge gate:
-- contiguous on main once the PRs before it land; draft until then.
ALTER TABLE leads ADD COLUMN evidence_translation TEXT CHECK (evidence_translation IS NULL OR char_length(evidence_translation) <= 400);
