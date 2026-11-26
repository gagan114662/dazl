import { asDb, type DbLike } from '../db/client.ts'

type Env = Record<string, string | undefined>

/** Each admitted request retains its reservation, including after an ambiguous timeout. */
export async function reserveApolloLead(
  store: DbLike,
  tenantId: string,
  leadId: string,
  env: Env = process.env,
  scan: { id: string; limit: number },
): Promise<boolean> {
  const rawCap = env.APOLLO_CREDIT_CAP ?? ''
  const cap = Number(rawCap)
  if (!/^[0-9]+$/.test(rawCap) || !Number.isSafeInteger(cap) || cap < 1 || !tenantId || !leadId ||
    !scan.id || !Number.isSafeInteger(scan.limit) || scan.limit < 1) return false

  try {
    return await asDb(store).tx(function* (tx) {
      // SQLite's write transaction serializes reservations. Lock across tenants in Postgres too.
      if (tx.kind === 'pg') yield* tx.get("SELECT pg_advisory_xact_lock(hashtext('apollo-credit-ledger')) AS locked")
      yield* tx.run(`CREATE TABLE IF NOT EXISTS apollo_credit_ledger (
        tenant_id TEXT NOT NULL,
        lead_id TEXT NOT NULL,
        scan_id TEXT NOT NULL,
        credit INTEGER NOT NULL DEFAULT 1,
        result TEXT NOT NULL DEFAULT 'reserved',
        PRIMARY KEY (tenant_id, lead_id)
      )`)
      const result = yield* tx.run(`INSERT INTO apollo_credit_ledger (tenant_id, lead_id, scan_id)
        SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM apollo_credit_ledger) < ?
        AND (SELECT COUNT(*) FROM apollo_credit_ledger WHERE tenant_id = ? AND scan_id = ?) < ?
        ON CONFLICT (tenant_id, lead_id) DO NOTHING`, [tenantId, leadId, scan.id, cap, tenantId, scan.id, scan.limit])
      return result.changes === 1
    })
  } catch {
    return false
  }
}

export async function recordApolloResult(
  store: DbLike, tenantId: string, leadId: string, result: 'matched' | 'empty' | 'uncertain',
): Promise<void> {
  await asDb(store).run(
    "UPDATE apollo_credit_ledger SET result = ? WHERE tenant_id = ? AND lead_id = ? AND result = 'reserved'",
    [result, tenantId, leadId],
  )
}
