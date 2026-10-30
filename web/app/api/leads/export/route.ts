import { readGdeltAttribution } from '@/lib/search/news-attribution'
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { exportLeads } from '@/lib/scan/store-db'
import { toCsv } from '@/lib/scan/csv'
import { eventDateCopy } from '@/lib/scan/date-copy'
import { exportEvidenceOrigin } from '@/lib/scan/evidence-origin'
import { bestPeople } from '@/lib/people/best-person'
import { denied } from '@/lib/workspace-access'

const COLUMNS = [
  { key: 'company', label: 'Company' },
  // The person to reach first (same ranking as the leads page: the scan's buyer roles). Found, not verified as current.
  { key: 'best_person', label: 'Best Person (research candidate, not verified as current)' },
  { key: 'best_person_title', label: 'Best Person Title' },
  { key: 'best_person_link', label: 'Best Person Profile or Source' },
  { key: 'best_person_found_via', label: 'Best Person Found Via' },
  { key: 'name', label: 'Contact Name' },
  { key: 'contact', label: 'Contact' },
  { key: 'signal', label: 'Signal' },
  { key: 'why', label: 'Why This Lead (model rationale)' },
  { key: 'human_confirmed_from', label: 'Confirmed By User (reason dazl could not verify)' },
  { key: 'fit', label: 'Fit (0-5)' },
  { key: 'intent', label: 'Saved Intent (historical, not current need proof)' },
  { key: 'action', label: 'Action (0-5)' },
  { key: 'score', label: 'Score (0-100)' },
  { key: 'confidence', label: 'Confidence' },
  { key: 'event_date', label: 'Event Date' },
  { key: 'date_status', label: 'Date Status (not current need verification)' },
  { key: 'date_context', label: 'Event Date Context' },
  { key: 'published_at', label: 'Page Published (a publication date only - NOT the event date)' },
  { key: 'timing_note', label: 'Timing Note (how a missing date was read from the page, or a season with no date)' },
  { key: 'evidence_excerpt', label: 'Evidence Excerpt (unconfirmed when Confirmed By User is set)' },
  { key: 'source_url', label: 'Source URL' },
  { key: 'evidence_origin_label', label: 'Evidence Origin (only what is recorded: copied page text, or page dazl could not read; blank = nothing recorded)' },
  { key: 'discovered_via', label: 'Found Through (discovery index; not the publisher)' },
  { key: 'discovered_via_link', label: 'Found Through (link)' },
  { key: 'review_reason', label: 'Review Reason' },
  { key: 'job_id', label: 'Scan Job' },
  { key: 'created_at', label: 'Found At (UTC)' },
]

export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'export'); if (no) return no
  const jobId = req.nextUrl.searchParams.get('job_id') ?? ''
  const db = await getDb()
  if (jobId && !/^[a-f0-9]{24}$/.test(jobId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // Default export is real leads only; ?include_fixtures=1 is the explicit opt-in
  // that keeps the verification fixture rows in the file.
  const includeFixtures = req.nextUrl.searchParams.get('include_fixtures') === '1'
  const rows = await exportLeads(db, user.tenantId, jobId || undefined, 5000, includeFixtures)
  const via = await readGdeltAttribution(db, user.tenantId, rows.map(r => String(r.lead_id)))
  const people = await bestPeople(db, user.tenantId, rows as { lead_id: string; job_id: string }[])
  const csv = toCsv(rows.map(r => ({ ...r, ...people.get(r.lead_id as string), discovered_via: via.get(String(r.lead_id))?.text ?? '', discovered_via_link: via.get(String(r.lead_id))?.link ?? '', evidence_origin_label: exportEvidenceOrigin(r as Parameters<typeof exportEvidenceOrigin>[0]), date_context: eventDateCopy(typeof r.event_date === 'string' ? r.event_date : null, typeof r.date_status === 'string' ? r.date_status : null), created_at: typeof r.created_at === 'number' ? new Date(r.created_at * 1000).toISOString() : r.created_at })), COLUMNS)
  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="dazl-leads${jobId ? `-${jobId}` : ''}.csv"`,
      'cache-control': 'no-store',
    },
  })
}
