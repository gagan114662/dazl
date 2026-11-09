-- #904 claims 0058 (~/work/migration_claims.txt); carried as 0056 = main highest 0055 + 1 so the no-gaps loader and CI pass while 0056/0057 are unlanded; renumber to main highest + 1 at merge.
-- #904: bind each indexing result to the domain it was checked against. Existing rows keep domain NULL and are
-- never read as current for any domain. Additive only; no data rewritten.
ALTER TABLE seo_index_results ADD COLUMN domain TEXT;
CREATE INDEX seo_index_results_domain ON seo_index_results (tenant_id, domain, keyword, checked_at);
