import { isDeepStrictEqual } from 'node:util'
import { asDb, type DbLike } from '../db/client.ts'
import { normalizeIcp, type Icp } from './icp.ts'

// Repeating an explicitly reviewed play is not a new targeting decision. Match
// server-owned review history, this tenant, this exact request and every field;
// a client assertion or a merely saved global buyer can never qualify.
export async function retainedReviewedTarget(db: DbLike, tenant: string, query: string, profile: Icp | null): Promise<boolean> {
  if (!profile || query.length < 3) return false
  const rows = await asDb(db).all<{ icp: string }>(
    'SELECT icp FROM scan_jobs WHERE user_id=? AND query=? AND icp_inferred=4', [tenant, query],
  )
  return rows.some(row => {
    try { return isDeepStrictEqual(normalizeIcp(JSON.parse(row.icp)), profile) }
    catch { return false }
  })
}
