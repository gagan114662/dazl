-- When a session last proved who it is (sign-in or re-authentication, lib/sessions.ts FRESH_AUTH_S). Existing
-- sessions count from when they were created.
ALTER TABLE sessions ADD COLUMN authed_at BIGINT;

UPDATE sessions SET authed_at = coalesce(created_at, 0) WHERE authed_at IS NULL;
