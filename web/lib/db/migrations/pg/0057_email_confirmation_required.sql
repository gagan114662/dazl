-- #357 (narrowed per review on #608): users.email_confirmation_required. 1 only for a password sign-up made while dazl
-- could mail its confirmation link (app/api/auth/signup/route.ts); every existing row gets 0 and keeps its sessions and
-- password sign-in as before. Nothing is marked verified. SQLite: migrateAuth (lib/db/sqlite-store.ts).
-- Carried as 0056 = main highest 0055 + 1 (claim 0059 in ~/work/migration_claims.txt; renumber to main highest + 1 at merge, #373 numbering contract).
ALTER TABLE users ADD COLUMN email_confirmation_required BIGINT NOT NULL DEFAULT 0;
