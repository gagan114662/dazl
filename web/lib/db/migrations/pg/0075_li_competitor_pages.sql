-- #1588: each competitor in Settings may carry its own LinkedIn page (a company page or a founder profile), the page dazl
-- Connect reads the competitor's recent posts from in the user's own browser (lib/linkedin-tasks/competitors.ts). Mirrors
-- the sqlite migrateCompetitors column; names alone keep working exactly as before.

ALTER TABLE tenant_competitors ADD COLUMN IF NOT EXISTS page_url TEXT;
