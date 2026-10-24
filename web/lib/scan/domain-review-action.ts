import type Database from 'better-sqlite3'
import { addEnrichment } from '../connectors/store.ts'
import { domainReviewFor, REVIEW_PREFIX } from '../outreach/domain-review.ts'

export type DomainReviewResult =
  | { status: 'not_found' }
  | { status: 'not_required' }
  | { status: 'stale' }
  | { status: 'confirmed'; domain: string }
  | { status: 'withdrawn' }

type Rows = NonNullable<Parameters<typeof domainReviewFor>[1]>

// The user's own check that the website behind a crawled address belongs to the company. One row per lead, connector
// 'user', confirmed against the binding the user's page showed, bound to the exact domain, how it was chosen, the pages behind it and the address (see domain-review.ts).
// It is not need, consent or a send approval. Nothing here sends or drafts.
export function setDomainReview(db: Database.Database, tenantId: string, leadId: string, action: 'confirm' | 'withdraw', expectedBinding?: string, now = Date.now()): DomainReviewResult {
  const lead = db.prepare('SELECT l.id, l.contact FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?').get(leadId, tenantId) as { id: string; contact: string | null } | undefined
  if (!lead) return { status: 'not_found' }
  if (action === 'withdraw') {
    db.prepare("DELETE FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = 'user' AND kind = 'domain_review'").run(lead.id, tenantId)
    return { status: 'withdrawn' }
  }
  // One IMMEDIATE transaction: the write lock is taken before the rows are read, so no other writer (another worker or script on the same
  // SQLite file) can change the evidence between the binding check and the review write.
  return db.transaction((): DomainReviewResult => {
    const rows = db.prepare("SELECT connector, kind, value, label, source_url, retrieved_at FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND ((connector = 'sitecrawl' AND kind IN ('email','domain')) OR (connector = 'user' AND kind = 'domain_review'))").all(lead.id, tenantId) as Rows
    const d = domainReviewFor(lead, rows)
    if (d.state === 'not_required' || !d.binding || !d.domain) return { status: 'not_required' }
    // The confirm covers exactly what the user saw: if the domain, basis, pages or address changed after their page loaded, nothing is recorded.
    if (expectedBinding !== d.binding) return { status: 'stale' }
    db.prepare("DELETE FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = 'user' AND kind = 'domain_review'").run(lead.id, tenantId)
    addEnrichment(db, tenantId, lead.id, { connector: 'user', kind: 'domain_review', value: d.domain, label: REVIEW_PREFIX + d.binding, confidence: null, source_url: d.basisSourceUrl ?? `https://${d.domain}/`, source_date: new Date(now).toISOString().slice(0, 10), retrieved_at: Math.floor(now / 1000) })
    return { status: 'confirmed', domain: d.domain }
  }).immediate()
}
