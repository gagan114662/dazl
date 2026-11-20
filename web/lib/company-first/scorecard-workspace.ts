// Admission component for a verified protected scorecard ticket only. Never
// infer ticket presence, actor, tenant or consent from an ordinary scan request.
import type { Tx, TxBody } from '../db/client.ts'

export type ScorecardWorkspaceBinding = Readonly<{
  tenantId: string
  actorId: string
  workspaceRevision: string
}>

export const SCORECARD_WORKSPACE_COLUMNS = [
  `ALTER TABLE organizations ADD COLUMN company_first_scorecard_enabled INTEGER NOT NULL DEFAULT 0
     CHECK (company_first_scorecard_enabled IN (0, 1))`,
  `ALTER TABLE organizations ADD COLUMN company_first_scorecard_revision TEXT
     CHECK (company_first_scorecard_revision IS NULL OR length(company_first_scorecard_revision) = 64)`,
] as const

type SqliteMigrationHandle = {
  prepare(sql: string): { all(): unknown[] }
  exec(sql: string): unknown
  transaction<T>(fn: () => T): { immediate(): T }
}

// After migrateAuth has created organizations. Serialize check+ALTER across startup
// processes; missing table or unexpected DDL failure is not a ready schema.
export function migrateScorecardWorkspaceSqlite(db: SqliteMigrationHandle): void {
  db.transaction(() => {
    const columns = db.prepare("PRAGMA table_info('organizations')").all() as { name: string }[]
    for (const [i, name] of ['company_first_scorecard_enabled', 'company_first_scorecard_revision'].entries()) {
      if (!columns.some(c => c.name === name)) db.exec(SCORECARD_WORKSPACE_COLUMNS[i])
    }
  }).immediate()
}

export function* requireScorecardWorkspace(t: Tx, binding: ScorecardWorkspaceBinding): TxBody<boolean> {
  const { tenantId, actorId, workspaceRevision } = binding
  if (!tenantId || !actorId || !/^[0-9a-f]{64}$/.test(workspaceRevision)) return false
  // Same advisory lock keys as the tenant deletion lifecycle. Acquire in stable
  // order before row locks. This transaction contains no network or provider work.
  if (t.kind === 'pg') {
    for (const id of [...new Set([tenantId, actorId])].sort())
      yield* t.get('SELECT pg_advisory_xact_lock_shared(hashtext(?))', [id])
  }
  // The signed revision is compared under lock, in the caller's ticket+
  // reservation transaction. A disabled row, stale revision, removed/demoted
  // owner or workspace/actor deletion is a denial, not an ordinary scan fallback.
  const locking = t.kind === 'pg' ? ' FOR SHARE OF o, m' : ''
  const ready = yield* t.get<{ eligible: number }>(`
    SELECT 1 AS eligible FROM organizations o
    JOIN memberships m ON m.tenant_id = o.id
    JOIN users u ON u.id = m.member_id
    WHERE o.id = ? AND m.member_id = ? AND m.role = 'owner'
      AND o.company_first_scorecard_enabled = 1
      AND o.company_first_scorecard_revision = ?
      AND NOT EXISTS (
        SELECT 1 FROM tenant_tombstones d WHERE d.deleted_tenant IN (o.id, u.id)
      )${locking}`, [tenantId, actorId, workspaceRevision])
  return ready?.eligible === 1
}
