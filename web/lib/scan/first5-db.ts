// Engine-neutral production read. The current HTTP route supplies sqliteDb on its SAME raw scan handle: this does not
// select DATABASE_URL, port the gate writer, or change runner/reaper behavior. Parent #920 requires further dependencies.
import type { Db } from '../db/client.ts'
import { FIRST5_TARGET, first5LeadSql, first5LeadOf, first5Mode, first5Of, type LeadRow } from './first5.ts'

export async function verifiedLeads(db: Db, userId: string, jobId: string, limit = FIRST5_TARGET) {
  let rows: LeadRow[]
  try { rows = await db.all<LeadRow>(first5LeadSql(), [jobId, userId, limit]) } catch (e) {
    // Legacy SQLite without the enrichment table has the same fallback as canonical and synchronous reads. PG schema
    // errors and other failures are not downgraded into a pass: they propagate.
    if (db.kind !== 'sqlite' || !/no such table/i.test(e instanceof Error ? e.message : '')) throw e
    rows = await db.all<LeadRow>(first5LeadSql(false), [jobId, userId, limit])
  }
  return rows.map(first5LeadOf)
}
export async function isFirst5(db: Db, userId: string, jobId: string): Promise<boolean> {
  const row = await db.get<{ run_budget: string | null }>('SELECT run_budget FROM scan_jobs WHERE id = ? AND user_id = ?', [jobId, userId])
  return first5Mode(row?.run_budget)
}
export async function readFirst5(db: Db, userId: string, jobId: string, input: Omit<Parameters<typeof first5Of>[0], 'leads'>) {
  if (!await isFirst5(db, userId, jobId)) return undefined
  return first5Of({ ...input, leads: await verifiedLeads(db, userId, jobId) })
}
