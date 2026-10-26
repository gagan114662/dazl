import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { exportLeads } from '@/lib/scan/store'
import { toCsv } from '@/lib/scan/csv'
import { eventDateCopy } from '@/lib/scan/date-copy'
import { bestPeople } from '@/lib/people/best-person'

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
  { key: 'evidence_excerpt', label: 'Evidence Excerpt (unconfirmed when Confirmed By User is set)' },
  { key: 'source_url', label: 'Source URL' },
  { key: 'review_reason', label: 'Review Reason' },
  { key: 'job_id', label: 'Scan Job' },
  { key: 'created_at', label: 'Found At (UTC)' },
]

export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const jobId = req.nextUrl.searchParams.get('job_id') ?? ''
  const db = getScanDb()
  if (jobId && !/^[a-f0-9]{24}$/.test(jobId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // Default export is real leads only; ?include_fixtures=1 is the explicit opt-in
  // that keeps the verification fixture rows in the file.
  const includeFixtures = req.nextUrl.searchParams.get('include_fixtures') === '1'
  const rows = exportLeads(db, user.id, jobId || undefined, 5000, includeFixtures) as Record<string, unknown>[]
  const people = bestPeople(db, user.id, rows as { lead_id: string; job_id: string }[])
  const csv = toCsv(rows.map(r => ({ ...r, ...people.get(r.lead_id as string), date_context: eventDateCopy(typeof r.event_date === 'string' ? r.event_date : null, typeof r.date_status === 'string' ? r.date_status : null), created_at: typeof r.created_at === 'number' ? new Date(r.created_at * 1000).toISOString() : r.created_at })), COLUMNS)
  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="dazl-leads${jobId ? `-${jobId}` : ''}.csv"`,
      'cache-control': 'no-store',
    },
  })
}
