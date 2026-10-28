import type Database from 'better-sqlite3'
import { runReportFor } from './run-report.ts'
import { emptyExtractionReason } from './extraction-note.ts'

// Server-only. The recorded extraction diagnostic for one of the tenant's own scans that extracted nothing - the same
// sentence the scan status read gives (search results, pages read, what extraction was given, 0 returned). null when the
// scan did not end that way or nothing was recorded. Read-only and owner-scoped (runReportFor joins on the tenant).
export function recordedEmptyReason(db: Database.Database, tenantId: string, job: { id: string; status: string; error: string | null; candidates?: number | null }): string | null {
  const extractedNone = job.error === 'no_candidates' || (job.status === 'done' && job.candidates === 0)
  if (!extractedNone) return null
  return emptyExtractionReason((runReportFor(db, tenantId, job.id) as { extraction?: never }[] | null)?.at(-1)?.extraction)
}
