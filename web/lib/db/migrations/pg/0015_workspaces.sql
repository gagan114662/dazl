-- Workspaces and memberships (lib/workspaces.ts, docs/design/workspaces.md). A personal workspace's id is its
-- founder's users.id, so existing tenant_id values need no rewrite; every existing user becomes the owner of their own.
CREATE TABLE organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '' CHECK (char_length(name) <= 150),
    kind TEXT NOT NULL CHECK (kind IN ('personal', 'team')),
    created_by TEXT NOT NULL,
    created_at BIGINT NOT NULL
  );

CREATE TABLE memberships (
    tenant_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
    created_at BIGINT NOT NULL,
    added_by TEXT,
    PRIMARY KEY (tenant_id, member_id)
  );

CREATE INDEX memberships_member ON memberships (member_id);

ALTER TABLE sessions ADD COLUMN active_tenant_id TEXT;

-- Backfill: the same statements as BACKFILL_SQL in lib/workspaces.ts (memberships first, while "no organizations row"
-- still selects exactly the users being backfilled).
INSERT INTO memberships (tenant_id, member_id, role, created_at)
  SELECT u.id, u.id, 'owner', coalesce(u.created_at, 0) FROM users u WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = u.id)
  ON CONFLICT (tenant_id, member_id) DO NOTHING;

INSERT INTO organizations (id, name, kind, created_by, created_at)
  SELECT u.id, substr(coalesce(u.business_name, ''), 1, 150), 'personal', u.id, coalesce(u.created_at, 0) FROM users u WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = u.id);
