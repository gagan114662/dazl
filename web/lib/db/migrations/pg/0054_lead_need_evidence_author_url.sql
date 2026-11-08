-- lead_need_evidence.author_url: the author's profile website exactly as the source payload reported it.
-- The second supported same-source binding (author website IS the lead's confirmed domain); never inferred (#401/#379 positive path).
ALTER TABLE lead_need_evidence ADD COLUMN IF NOT EXISTS author_url TEXT;
