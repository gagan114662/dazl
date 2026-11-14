// #1038: the Leads table - the workspace's leads ACROSS scans as scannable rows (company, person, signal with its date, fit,
// email, state), sorted by fit or by event date, 50 to a page. Read-only and tenant-scoped (the join to scan_jobs.user_id is
// the tenant check). Shown rows follow the cards' own defaults for what is left out: a poor fit (fit <= 1), a test-fixture lead and a company
// found again by a later scan (seen_before) are not listed. A lead the cards put under "Needs your review" IS listed, as
// its own state (never as an ordinary row), with the same held-gate overlay the cards' read applies (HELD_REVIEW), and a
// date the cards would not call verified says so (eventDayVerified). State: rejected (quarantined), drafted (an outreach
// draft exists - what "Approve" makes on Leads), needs_review, otherwise to review. On the Db layer (SQLite and Postgres).
import type { Db } from '../db/client.ts'
import { HELD_REVIEW } from '../scan/store.ts'
import { eventDayVerified } from '../scan/scoreboard.ts'

export const TABLE_PAGE = 50
export type TableSort = 'fit' | 'date'
export type RowState = 'review' | 'needs_review' | 'drafted' | 'rejected'
export interface TableRow {
  id: string; job_id: string; company: string; company_domain: string | null; person: string | null; email: string | null
  signal: string; quote: string | null; source_url: string; event_date: string | null; found_at: number; fit: number | null
  review_reason: string | null; why: string | null; day_verified: boolean; state: RowState
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

export async function leadsTable(db: Db, tenantId: string, opts: { sort?: unknown; page?: unknown } = {}): Promise<TablePage> {
  const sort = parseSort(opts.sort)
  const total = Number((await db.get<{ n: number | string }>(`SELECT count(*) AS n FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE ${WHERE}`, [tenantId]))?.n ?? 0)
  const pages = Math.max(1, Math.ceil(total / TABLE_PAGE))
  const page = Math.min(parsePage(opts.page), pages)
  type Raw = { id: string; job_id: string; company: string; name: string; company_domain: string | null; contact: string | null; signal: string; signal_kind: string | null; quote: string | null
    source_url: string; event_date: string | null; event_date_proof: string | null; found_at: number | string; fit: number | string | null; review_reason: string | null; why: string | null; quarantined_at: number | string | null; drafted: number | boolean }
  // The held-gate overlay (HELD_REVIEW) and the drafts join read the same tables the cards' read does; a read that fails
  // propagates (the route answers 503), never an "all to review" table.
  const raw = await db.all<Raw>(`SELECT l.id, l.scan_job_id AS job_id, l.company, l.name, l.company_domain, l.contact, l.signal, l.signal_kind, l.evidence_excerpt AS quote,
      l.source_url, l.event_date, l.event_date_proof, l.created_at AS found_at, l.fit, ${HELD_REVIEW}, l.why, l.quarantined_at, (m.id IS NOT NULL) AS drafted
    FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id LEFT JOIN outreach_messages m ON m.tenant_id = j.user_id AND m.lead_id = l.id
    WHERE ${WHERE} ORDER BY ${ORDER[sort]} LIMIT ? OFFSET ?`, [tenantId, TABLE_PAGE, (page - 1) * TABLE_PAGE])
  const rows: TableRow[] = raw.map(r => ({
    id: r.id, job_id: r.job_id, company: r.company || r.name, company_domain: r.company_domain,
    person: r.company && r.name && r.name !== r.company ? r.name : null, email: r.contact, signal: r.signal, quote: r.quote,
    source_url: r.source_url, event_date: r.event_date, found_at: Number(r.found_at), fit: r.fit == null ? null : Number(r.fit), review_reason: r.review_reason, why: r.why, day_verified: eventDayVerified(r),
    state: r.quarantined_at ? 'rejected' : r.drafted ? 'drafted' : r.review_reason ? 'needs_review' : 'review',
  }))
  return { rows, total, page, pages, sort }
}
