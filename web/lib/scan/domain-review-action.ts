import type Database from 'better-sqlite3'
import { StatementFailedInTx, type Db, type TxBody } from '../db/client.ts'
import { addEnrichment, addEnrichmentTx, type Enrichment } from '../connectors/store.ts'
import { domainReviewFor, REVIEW_PREFIX } from '../outreach/domain-review.ts'

// Postgres SQLSTATE 40001 (serialization_failure): the SERIALIZABLE confirm below aborts a transaction whose read
// would conflict with a concurrent writer, usually detected at COMMIT (raw pg.Pool error, not wrapped) rather than
// on an individual statement (wrapped in StatementFailedInTx). Either shape means the same thing a changed binding
// means: the confirm was not proven against what the route checked, so it answers the existing 'stale' 409 instead
// of letting a driver-level error surface as an unhandled 500.
const isSerializationFailure = (e: unknown): boolean => {
  const code = e instanceof StatementFailedInTx ? (e.cause as { code?: unknown } | undefined)?.code : (e as { code?: unknown } | null)?.code
  return code === '40001'
}

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
  const lead = db.prepare(LEAD_SQL).get(leadId, tenantId) as { id: string; contact: string | null } | undefined
  if (!lead) return { status: 'not_found' }
  if (action === 'withdraw') {
    db.prepare(WITHDRAW_SQL).run(lead.id, tenantId)
    return { status: 'withdrawn' }
  }
  // One IMMEDIATE transaction: the write lock is taken before the rows are read, so no other writer (another worker or script on the same
  // SQLite file) can change the evidence between the binding check and the review write.
  return db.transaction((): DomainReviewResult => {
    const rows = db.prepare(ROWS_SQL).all(lead.id, tenantId) as Rows
    const d = domainReviewFor(lead, rows)
    if (d.state === 'not_required' || !d.binding || !d.domain) return { status: 'not_required' }
    // The confirm covers exactly what the user saw: if the domain, basis, pages or address changed after their page loaded, nothing is recorded.
    if (expectedBinding !== d.binding) return { status: 'stale' }
    db.prepare(WITHDRAW_SQL).run(lead.id, tenantId)
    addEnrichment(db, tenantId, lead.id, reviewRow(d.domain, d.binding, d.basisSourceUrl, now))
    return { status: 'confirmed', domain: d.domain }
  }).immediate()
}

const LEAD_SQL = 'SELECT l.id, l.contact FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?'
const WITHDRAW_SQL = "DELETE FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = 'user' AND kind = 'domain_review'"
const ROWS_SQL = "SELECT connector, kind, value, label, source_url, retrieved_at FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND ((connector = 'sitecrawl' AND kind IN ('email','domain')) OR (connector = 'user' AND kind = 'domain_review'))"
const ROWS_IN_ORDER_SQL = `${ROWS_SQL} ORDER BY insert_seq`
const reviewRow = (domain: string, binding: string, basisSourceUrl: string | null, now: number): Enrichment =>
  ({ connector: 'user', kind: 'domain_review', value: domain, label: REVIEW_PREFIX + binding, confidence: null, source_url: basisSourceUrl ?? `https://${domain}/`, source_date: new Date(now).toISOString().slice(0, 10), retrieved_at: Math.floor(now / 1000) })

// setDomainReview on the Db layer (SQLite or Postgres) for the domain-review route (#354): the same statements and the
// same outcomes. The confirm is one transaction: on SQLite an IMMEDIATE one (the write lock is taken before the rows
// are read, as above); on Postgres SERIALIZABLE, so a concurrent change to the evidence aborts it rather than letting a
// confirm land on rows the binding check did not see. Either way a conflict throws; nothing is recorded. On Postgres
// that throw is a 40001 serialization failure, answered as 'stale' (the same thing a changed binding means: the
// confirm was not proven against what the route checked) rather than an unhandled 500 from the route.
// The evidence rows are read in insert_seq order: on SQLite that is the order the sync read returns (rowid order),
// and it gives Postgres the same order, so pickCrawledEmail's tie-break picks the same address on both engines.
export async function setDomainReviewDb(db: Db, tenantId: string, leadId: string, action: 'confirm' | 'withdraw', expectedBinding?: string, now = Date.now()): Promise<DomainReviewResult> {
  const lead = await db.get<{ id: string; contact: string | null }>(LEAD_SQL, [leadId, tenantId])
  if (!lead) return { status: 'not_found' }
  if (action === 'withdraw') {
    await db.run(WITHDRAW_SQL, [lead.id, tenantId])
    return { status: 'withdrawn' }
  }
  try {
    return await db.tx(function* (t): TxBody<DomainReviewResult> {
      const rows = (yield* t.all(ROWS_IN_ORDER_SQL, [lead.id, tenantId])) as Rows
      const d = domainReviewFor(lead, rows)
      if (d.state === 'not_required' || !d.binding || !d.domain) return { status: 'not_required' }
      if (expectedBinding !== d.binding) return { status: 'stale' }
      yield* t.run(WITHDRAW_SQL, [lead.id, tenantId])
      yield* addEnrichmentTx(t, tenantId, lead.id, reviewRow(d.domain, d.binding, d.basisSourceUrl, now))
      return { status: 'confirmed', domain: d.domain }
    }, 'serializable')
  } catch (e) {
    if (isSerializationFailure(e)) return { status: 'stale' }
    throw e
  }
}
