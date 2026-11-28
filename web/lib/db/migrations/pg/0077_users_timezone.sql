-- #2054 follow-up: users.timezone - the account's IANA time zone, saved at password signup from the browser's zone
-- (or later in Settings; Google and native-form sign-ups get it from the post-signup capture through
-- /api/settings/profile). lib/account-zone.ts reads it for the account's own day (send caps, the per-account trial
-- count, shown reset times). NULL means no zone saved: every reader falls back to UTC, and rows that existed before
-- this column read NULL, unchanged. SQLite: migrateAuth (lib/db/sqlite-store.ts).
-- Slot 0077 per the landing order on #2020: after 0074 (#2064), 0075 (#2062) and 0076 (#2028).
ALTER TABLE users ADD COLUMN timezone TEXT;
