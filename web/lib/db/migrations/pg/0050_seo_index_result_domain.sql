-- LOCAL PLACEHOLDER - number must be reassigned to main's highest + 1 AT MERGE TIME (numbering contract, refs #373).
-- #904: bind each indexing result to the domain it was checked against. Existing rows keep domain NULL and are
-- never read as current for any domain. Additive only; no data rewritten.
ALTER TABLE seo_index_results ADD COLUMN domain TEXT;
CREATE INDEX seo_index_results_domain ON seo_index_results (tenant_id, domain, keyword, checked_at);
