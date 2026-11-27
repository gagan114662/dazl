import { asDb, type DbLike } from '../db/client.ts'

type Env = Record<string, string | undefined>
type ScanLimit = { id: string; limit: number }

export const APOLLO_CREDIT_LEDGER_SCHEMA = `CREATE TABLE IF NOT EXISTS apollo_credit_ledger (
  tenant_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  credit INTEGER NOT NULL DEFAULT 1,
  result TEXT NOT NULL DEFAULT 'reserved',
  PRIMARY KEY (tenant_id, lead_id)
)`

export const APOLLO_CREDIT_TOTAL_SCHEMA = `CREATE TABLE apollo_credit_total (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  used INTEGER CHECK (used >= 0)
)`

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
      const result = yield* tx.run(`INSERT INTO apollo_credit_ledger (tenant_id, lead_id, scan_id)
        SELECT ?, ?, ? WHERE (SELECT used FROM apollo_credit_total WHERE singleton = 1) < ?
        AND (SELECT COUNT(*) FROM apollo_credit_ledger WHERE tenant_id = ? AND scan_id = ?) < ?
        ON CONFLICT (tenant_id, lead_id) DO NOTHING`, [tenantId, leadId, scan.id, cap, tenantId, scan.id, scan.limit])
      if (result.changes !== 1) return false
      const tally = yield* tx.run('UPDATE apollo_credit_total SET used = used + 1 WHERE singleton = 1 AND used < ?', [cap])
      if (tally.changes !== 1) throw new Error('Apollo lifetime reservation was not recorded')
      return true
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
  let rows: { used: number | string | null; lead_id: string | null; scan_id: string | null }[]
  try {
    rows = await asDb(store).all(`SELECT t.used, l.lead_id, l.scan_id FROM apollo_credit_total t
      LEFT JOIN apollo_credit_ledger l ON l.tenant_id = ? WHERE t.singleton = 1`, [tenantId])
  } catch (error) {
    const e = error as { code?: string; message?: string }
    if (e.code === '42P01' || /^no such table: apollo_credit_(ledger|total)$/i.test(e.message ?? '')) return []
    throw error
  }
  if (rows[0]?.used == null) return []
  const used = Number(rows[0].used)
  if (!Number.isSafeInteger(used) || used < 0) return []
  const available = Math.max(0, Math.min(cap - used,
    scan.limit - rows.filter(row => row.scan_id === scan.id).length))
  const seen = new Set(rows.map(row => row.lead_id))
  return [...new Set(leadIds)].filter(id => id && !seen.has(id)).slice(0, available)
}
