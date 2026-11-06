-- #357 (narrowed per review on #608): users.email_confirmation_required. 1 only for a password sign-up made while dazl
-- could mail its confirmation link (app/api/auth/signup/route.ts); every existing row gets 0 and keeps its sessions and
-- password sign-in as before. Nothing is marked verified. SQLite: migrateAuth (lib/db/sqlite-store.ts).
-- Numbered 0050: main's highest + 1 at rebase onto b529b3b5 (top 0049_first_party_withdrawals); re-checked against
-- main's top at the merge gate (#373 numbering contract).
ALTER TABLE users ADD COLUMN email_confirmation_required BIGINT NOT NULL DEFAULT 0;
