import type Database from 'better-sqlite3'
import { audit, addEnrichment, getEnabledCredential } from './store.ts'
import { hunterDomainSearch } from './hunter.ts'

export const MAX_ENRICH_PER_SCAN = 10

// Enriches verified leads of one finished scan using the tenant's enabled connectors.
// Never throws and never changes the lead itself. Only the tenant's own credential is used.
export async function enrichJob(db: Database.Database, tenantId: string, jobId: string, deps: { fetchImpl?: typeof fetch; master?: Buffer } = {}): Promise<void> {
  try {
    const key = getEnabledCredential(db, tenantId, 'hunter', deps.master)
    if (!key) return
    const leads = db.prepare("SELECT id, company FROM leads WHERE scan_job_id = ? AND review_reason IS NULL AND confidence IS NOT NULL AND company <> '' ORDER BY score DESC LIMIT ?").all(jobId, MAX_ENRICH_PER_SCAN) as { id: string; company: string }[]
    for (const l of leads) {
      const r = await hunterDomainSearch(key, l.company, deps.fetchImpl)
      if (!r.ok) {
        audit(db, { tenantId, connector: 'hunter', jobId, lookup: l.company, status: r.reason, results: 0 })
        if (r.reason === 'auth' || r.reason === 'rate_limited') return // stop spending calls
        continue
      }
      for (const e of r.enrichments) addEnrichment(db, tenantId, l.id, e)
      audit(db, { tenantId, connector: 'hunter', jobId, lookup: l.company, status: 'ok', results: r.enrichments.length })
    }
  } catch (e) {
    console.error('enrichment failed', jobId, e instanceof Error ? e.message : 'error')
  }
}
