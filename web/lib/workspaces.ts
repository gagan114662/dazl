// Workspaces (organizations) and memberships: who may act in which tenant, and as what (docs/design/workspaces.md).
//
// A tenant is a workspace. Every tenant_id in the schema is an organizations.id. A personal workspace's id is its
// founder's users.id, so every tenant_id written before workspaces existed is already the right workspace id: the
// migration adds rows, it never rewrites tenant data. The actor (users.id of the person acting) is separate from the
// tenant and comes only from the session; the tenant comes only from a membership row the server reads on every request.
import type { Db, Tx, TxBody } from './db/client.ts'

export const ROLES = ['viewer', 'operator', 'admin', 'owner'] as const
export type Role = typeof ROLES[number]
const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 }
export const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v)

// What a role may do, as the lowest role allowed. Routes ask can(role, action); none compare roles themselves.
//   read       see the workspace's leads, campaigns, replies, settings status (never secret values)
//   export     download the workspace's data (CSV); viewers can already read every row, so this adds no access
//   operate    spend or change work: launch scans, edit leads, drafts, stages, CRM pushes, monitors
//   send       anything that reaches a third party: outreach sends, follow-ups, autopilot
//   configure  connectors, API keys, sending accounts, workspace profile
//   members    invite, remove and change the role of non-owner members
//   billing    plans, checkout, the billing portal
//   owners     grant or remove the owner role, delete the workspace
export const ACTIONS = { read: 'viewer', export: 'viewer', operate: 'operator', send: 'operator', configure: 'admin', members: 'admin', billing: 'owner', owners: 'owner' } as const satisfies Record<string, Role>
export type Action = keyof typeof ACTIONS
export function can(role: Role | null | undefined, action: Action): boolean {
  return !!role && isRole(role) && RANK[role] >= RANK[ACTIONS[action]]
}

const nowS = () => Math.floor(Date.now() / 1000)

// Tables only. SQLite: migrateAuth (lib/auth-db.ts) runs this and BACKFILL_SQL at startup and adds
// sessions.active_tenant_id; PG: 0015_workspaces.sql.
// memberships.member_id, not user_id: tenant-scoped tables key on tenant_id, and the member is an actor, not a tenant.
export const WORKSPACE_DDL = `
  CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 150),
    kind TEXT NOT NULL CHECK (kind IN ('personal', 'team')),
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memberships (
    tenant_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
    created_at INTEGER NOT NULL,
    added_by TEXT,
    PRIMARY KEY (tenant_id, member_id)
  );
  CREATE INDEX IF NOT EXISTS memberships_member ON memberships (member_id);
`

// Every user without a workspace row gets their personal workspace, owned by them. Keyed on the organizations row, not
// on memberships: a founder later removed from their own workspace keeps the row and is never re-added. Memberships go
// first, while "no organizations row" still selects exactly these users. Same SQL on both engines (PG: 0013).
export const BACKFILL_SQL = [
  `INSERT INTO memberships (tenant_id, member_id, role, created_at)
     SELECT u.id, u.id, 'owner', coalesce(u.created_at, 0) FROM users u WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = u.id)
     ON CONFLICT (tenant_id, member_id) DO NOTHING`,
  `INSERT INTO organizations (id, name, kind, created_by, created_at)
     SELECT u.id, substr(coalesce(u.business_name, ''), 1, 150), 'personal', u.id, coalesce(u.created_at, 0) FROM users u WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = u.id)`,
]

// The personal workspace for a user that has none, inside the caller's transaction. Does nothing when the workspace
// row already exists (made earlier, or the founder has since left it): only the insert that creates the row adds the
// owner, so a concurrent call or a removed founder can never be (re)granted access here.
export function* createPersonalWorkspace(t: Tx, userId: string, name: string): TxBody<boolean> {
  const o = yield* t.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, ?, 'personal', ?, ?) ON CONFLICT (id) DO NOTHING",
    [userId, name.slice(0, 150), userId, nowS()])
  if (o.changes !== 1) return false
  yield* t.run("INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, 'owner', ?) ON CONFLICT (tenant_id, member_id) DO NOTHING",
    [userId, userId, nowS()])
  return true
}

export type Membership = { tenantId: string; role: Role }

// The workspace a session acts in. `active` is the session's chosen workspace (null: none chosen). A chosen workspace
// counts only while its membership row exists, so a removed member loses it on their next request on any instance;
// it never falls through to another workspace, since the request was meant for the chosen one. With none chosen: the
// personal workspace, else the oldest membership. A user from before workspaces (no row at all) gets their personal
// workspace made here, exactly as the startup backfill would.
export async function resolveMembership(db: Db, user: { id: string; business_name: string | null }, active: string | null): Promise<Membership | null> {
  const role = async (tenantId: string) => (await db.get<{ role: string }>('SELECT role FROM memberships WHERE tenant_id = ? AND member_id = ?', [tenantId, user.id]))?.role
  if (active !== null) {
    const r = await role(active)
    return isRole(r) ? { tenantId: active, role: r } : null
  }
  const own = await role(user.id)
  if (isRole(own)) return { tenantId: user.id, role: own }
  const first = await db.get<{ tenant_id: string; role: string }>('SELECT tenant_id, role FROM memberships WHERE member_id = ? ORDER BY created_at, tenant_id LIMIT 1', [user.id])
  if (first && isRole(first.role)) return { tenantId: first.tenant_id, role: first.role }
  if (await db.tx(t => createPersonalWorkspace(t, user.id, user.business_name ?? ''))) {
    const made = await role(user.id)
    if (isRole(made)) return { tenantId: user.id, role: made }
  }
  return null
}
