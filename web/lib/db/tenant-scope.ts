import type { Db, Tx, TxBody } from './client.ts'

// Use the tenant resolved from the authenticated membership. Only statements
// yielded through this transaction see its tenant context; the pool is safe to
// reuse after either commit or rollback. RLS still requires a restricted app role.
export function withTenantTransaction<T>(db: Db, tenantId: string, body: (tx: Tx) => TxBody<T>): Promise<T> {
  if (!tenantId.trim()) return Promise.reject(new Error('Tenant transaction requires a tenant id'))
  return db.tx(function* (tx) {
    if (db.kind === 'pg') yield* tx.get("SELECT set_config('app.tenant_id', ?, true)", [tenantId])
    return yield* body(tx)
  })
}
