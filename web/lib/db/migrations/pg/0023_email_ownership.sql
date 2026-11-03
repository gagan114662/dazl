-- Email ownership and account recovery (lib/email-ownership.ts, lib/system-mail.ts): when an account proved its
-- email, one-use hashed link tokens, and the outbox for mail dazl sends when no SMTP transport is configured.
ALTER TABLE users ADD COLUMN email_verified_at BIGINT;

CREATE TABLE email_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset', 'change')),
    email TEXT NOT NULL CHECK (char_length(email) <= 254),
    token_hash TEXT NOT NULL UNIQUE,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    used_at BIGINT
  );

CREATE INDEX email_tokens_user ON email_tokens (user_id, purpose);

CREATE TABLE system_mail_outbox (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    to_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at BIGINT NOT NULL
  );

CREATE INDEX system_mail_outbox_created ON system_mail_outbox (created_at);

-- Google accounts: Google verified the address. Same statement as VERIFIED_BACKFILL_SQL in lib/email-ownership.ts.
UPDATE users SET email_verified_at = coalesce(created_at, 0)
  WHERE email_verified_at IS NULL AND EXISTS (SELECT 1 FROM oauth_identities o WHERE o.user_id = users.id AND o.provider = 'google');
