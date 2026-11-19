import type Database from 'better-sqlite3'
import type { Vendor } from '../../lib/llm/vendors.ts'

// Admission still checks the same tenant's latest stored vendor; only the asynchronous runner is replaced.
export function pickVendor(db: Database.Database, tenantId: string): Vendor | null {
  const rows = db.prepare('SELECT vendor FROM tenant_llm_keys WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC').all(tenantId) as { vendor: Vendor }[]
  return rows[0]?.vendor ?? null
}

// The scan route's kickRunner only starts the async runner; the route boundary under test ends at the stored job.
export const kickRunner = async (): Promise<void> => {}
// /api/scan/icp's previewIcp: replaced by the route test so each failure name can be produced on demand.
let stub: (() => Promise<unknown>) | null = null
export function setPreviewIcp(f: (() => Promise<unknown>) | null): void { stub = f }
// Arguments arrive (db, tenant, query, deps, ip) but the stub decides by queue, not by input: no binding needed.
export const previewIcp = async (): Promise<unknown> => {
  if (!stub) throw new Error('previewIcp stub unset')
  return stub()
}
