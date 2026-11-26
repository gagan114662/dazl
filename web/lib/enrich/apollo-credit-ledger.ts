import { asDb, type DbLike } from '../db/client.ts'

type Env = Record<string, string | undefined>
type ScanLimit = { id: string; limit: number }

export const APOLLO_PILOT_MAX_CREDITS = 50

export function apolloCreditCap(env: Env): number {
  const raw = env.APOLLO_CREDIT_CAP ?? ''
  const cap = Number(raw)
  return /^[0-9]+$/.test(raw) && Number.isSafeInteger(cap) && cap > 0 && cap <= APOLLO_PILOT_MAX_CREDITS ? cap : 0
}

function validScan(scan: ScanLimit): boolean {
  return !!scan.id && Number.isSafeInteger(scan.limit) && scan.limit > 0
}

/** Each admitted request retains its reservation, including after an ambiguous timeout. */
export async function reserveApolloLead(
  store: DbLike,
  tenantId: string,
  leadId: string,
  env: Env = process.env,
  scan: ScanLimit,
): Promise<boolean> {
  const cap = apolloCreditCap(env)
  if (!cap || !tenantId || !leadId || !validScan(scan)) return false

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

/** Snapshot only. A later attempt must still acquire a durable reservation. */
export async function planApolloReservations(
  store: DbLike, tenantId: string, leadIds: readonly string[], env: Env, scan: ScanLimit,
): Promise<string[]> {
  const cap = apolloCreditCap(env)
  if (!cap || !tenantId || !validScan(scan) || !leadIds.length) return []
  let reservations: { tenant_id: string; lead_id: string; scan_id: string }[]
  try {
    reservations = await asDb(store).all('SELECT tenant_id, lead_id, scan_id FROM apollo_credit_ledger')
  } catch (error) {
    const e = error as { code?: string; message?: string }
    if (e.code !== '42P01' && !/^no such table: apollo_credit_ledger$/i.test(e.message ?? '')) throw error
    reservations = []
  }
  const own = reservations.filter(row => row.tenant_id === tenantId)
  const available = Math.max(0, Math.min(cap - reservations.length,
    scan.limit - own.filter(row => row.scan_id === scan.id).length))
  const used = new Set(own.map(row => row.lead_id))
  return [...new Set(leadIds)].filter(id => id && !used.has(id)).slice(0, available)
}
