import { asDb, type DbLike } from '../db/client.ts'

type Env = Record<string, string | undefined>

/** Each admitted request retains its reservation, including after an ambiguous timeout. */
export async function reserveApolloLead(
  store: DbLike,
  tenantId: string,
  leadId: string,
  env: Env = process.env,
): Promise<boolean> {
  const rawCap = env.APOLLO_CREDIT_CAP ?? ''
  const cap = Number(rawCap)
  if (!/^[0-9]+$/.test(rawCap) || !Number.isSafeInteger(cap) || cap < 1 || !tenantId || !leadId) return false

  try {
    return await asDb(store).tx(function* (tx) {
      // SQLite's write transaction serializes reservations. Lock across tenants in Postgres too.
      if (tx.kind === 'pg') yield* tx.get("SELECT pg_advisory_xact_lock(hashtext('apollo-credit-ledger')) AS locked")
      yield* tx.run(`CREATE TABLE IF NOT EXISTS apollo_credit_ledger (
        tenant_id TEXT NOT NULL,
        lead_id TEXT NOT NULL,
        PRIMARY KEY (tenant_id, lead_id)
      )`)
      const result = yield* tx.run(`INSERT INTO apollo_credit_ledger (tenant_id, lead_id)
        SELECT ?, ? WHERE (SELECT COUNT(*) FROM apollo_credit_ledger) < ?
        ON CONFLICT (tenant_id, lead_id) DO NOTHING`, [tenantId, leadId, cap])
      return result.changes === 1
    })
  } catch {
    return false
  }
}
