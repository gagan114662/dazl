-- Session inventory and revocation (lib/sessions.ts): a public id to show instead of the token hash, last activity, a
-- coarse device label, and who revoked a session, when and why.
ALTER TABLE sessions ADD COLUMN public_id TEXT;
ALTER TABLE sessions ADD COLUMN last_seen_at BIGINT;
ALTER TABLE sessions ADD COLUMN device TEXT;
ALTER TABLE sessions ADD COLUMN revoked_at BIGINT;
ALTER TABLE sessions ADD COLUMN revoked_by TEXT;
ALTER TABLE sessions ADD COLUMN revoke_reason TEXT;

-- Existing sessions get a public id (not secret: it only names the row in the account's own list).
UPDATE sessions SET public_id = substr(md5(random()::text || clock_timestamp()::text || id), 1, 24) WHERE public_id IS NULL;

CREATE UNIQUE INDEX sessions_public_id ON sessions (public_id);

CREATE INDEX sessions_user ON sessions (user_id);

CREATE INDEX sessions_expires ON sessions (expires_at);
