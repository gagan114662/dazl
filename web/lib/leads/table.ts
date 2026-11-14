// #1038: the Leads table - the workspace's leads ACROSS scans as scannable rows (company, person, signal with its date, fit,
// email, state), sorted by fit or by event date, 50 to a page. Read-only and tenant-scoped (the join to scan_jobs.user_id is
// the tenant check). Shown rows follow the cards' own defaults: a poor fit (fit <= 1), a test-fixture lead and a company
// found again by a later scan (seen_before) are not listed. State: rejected (quarantined), drafted (an outreach draft
// exists - what "Approve" makes on Leads), otherwise to review. On the scan store's synchronous handle, like GET /api/leads.
import type Database from 'better-sqlite3'

export const TABLE_PAGE = 50
export type TableSort = 'fit' | 'date'
export type RowState = 'review' | 'drafted' | 'rejected'
export interface TableRow {
  id: string; job_id: string; company: string; company_domain: string | null; person: string | null; email: string | null
  signal: string; quote: string | null; source_url: string; event_date: string | null; found_at: number; fit: number | null
  review_reason: string | null; why: string | null; state: RowState
}
export interface TablePage { rows: TableRow[]; total: number; page: number; pages: number; sort: TableSort }

export const parseSort = (v: unknown): TableSort => (v === 'date' ? 'date' : 'fit')
export const parsePage = (v: unknown): number => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 1 && n <= 10000 ? n : 1 }

const ORDER: Record<TableSort, string> = {
  fit: '(l.fit IS NULL), l.fit DESC, l.created_at DESC, l.insert_seq, l.id',
  date: '(l.event_date IS NULL), l.event_date DESC, (l.fit IS NULL), l.fit DESC, l.created_at DESC, l.insert_seq, l.id',
}
const WHERE = `j.user_id = ? AND NOT (j.industry = 'test only' AND j.location = 'test only')
  AND (l.fit IS NULL OR l.fit > 1) AND COALESCE(l.source_kind, '') <> 'test' AND COALESCE(l.seen_before, 0) = 0`

export function leadsTable(db: Database.Database, tenantId: string, opts: { sort?: unknown; page?: unknown } = {}): TablePage {
  const sort = parseSort(opts.sort)
  const total = (db.prepare(`SELECT count(*) AS n FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE ${WHERE}`).get(tenantId) as { n: number }).n
  const pages = Math.max(1, Math.ceil(total / TABLE_PAGE))
  const page = Math.min(parsePage(opts.page), pages)
  const sql = (join: string, drafted: string) => `SELECT l.id, l.scan_job_id AS job_id, l.company, l.name, l.company_domain, l.contact, l.signal, l.evidence_excerpt AS quote,
      l.source_url, l.event_date, l.created_at AS found_at, l.fit, l.review_reason, l.why, l.quarantined_at, ${drafted} AS drafted
    FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id ${join} WHERE ${WHERE} ORDER BY ${ORDER[sort]} LIMIT ? OFFSET ?`
  type Raw = { id: string; job_id: string; company: string; name: string; company_domain: string | null; contact: string | null; signal: string; quote: string | null
    source_url: string; event_date: string | null; found_at: number; fit: number | null; review_reason: string | null; why: string | null; quarantined_at: number | null; drafted: number }
  const args = [tenantId, TABLE_PAGE, (page - 1) * TABLE_PAGE]
  let raw: Raw[]
  try { raw = db.prepare(sql('LEFT JOIN outreach_messages m ON m.tenant_id = j.user_id AND m.lead_id = l.id', '(m.id IS NOT NULL)')).all(...args) as Raw[] }
  catch { raw = db.prepare(sql('', '0')).all(...args) as Raw[] }   // a store without the outreach table has no drafts yet
  const rows: TableRow[] = raw.map(r => ({
    id: r.id, job_id: r.job_id, company: r.company || r.name, company_domain: r.company_domain,
    person: r.company && r.name && r.name !== r.company ? r.name : null, email: r.contact, signal: r.signal, quote: r.quote,
    source_url: r.source_url, event_date: r.event_date, found_at: r.found_at, fit: r.fit, review_reason: r.review_reason, why: r.why,
    state: r.quarantined_at ? 'rejected' : r.drafted ? 'drafted' : 'review',
  }))
  return { rows, total, page, pages, sort }
}
