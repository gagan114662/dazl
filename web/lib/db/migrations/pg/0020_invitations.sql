-- Workspace invitations (lib/workspace-members.ts): one-use, expiring, bound to an email; only the token's SHA-256 is
-- stored.
CREATE TABLE invitations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    email TEXT NOT NULL CHECK (char_length(email) <= 254),
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
    token_hash TEXT NOT NULL UNIQUE,
    invited_by TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    accepted_at BIGINT,
    accepted_by TEXT,
    revoked_at BIGINT
  );

CREATE INDEX invitations_tenant ON invitations (tenant_id, created_at);
