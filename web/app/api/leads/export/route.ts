import { readGdeltAttribution } from '@/lib/search/news-attribution'
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { exportLeadCursor, exportLeadPage, parseExportLeadCursor } from '@/lib/scan/store-db'
import { toCsv } from '@/lib/scan/csv'
import { eventDateCopy } from '@/lib/scan/date-copy'
import { timingUnconfirmedReason, eventDayVerified, surfaceStoredIntent, TIMING_REQUESTED } from '@/lib/scan/scoreboard'
import { jobWindowDays } from '@/lib/scan/window'
import { exportEvidenceOrigin } from '@/lib/scan/evidence-origin'
import { bestPeople } from '@/lib/people/best-person'
import { audit } from '@/lib/audit-route'
import { hasCompanyFirstBudget } from '@/lib/company-first/product-discovery'
import { markedCurrentnessHeldDb } from '@/lib/outreach/currentness'
import { requiredGateHeldForJob } from '@/lib/scan/held-state'
import { denied } from '@/lib/workspace-access'

const EXPORT_ROW_LIMIT = 5000
const EXPORT_BATCH = 500
const EXPORT_WORK_LIMIT = 10000
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
  // #830: a scan id that is not this workspace's own is not found, the same as one that does not exist (never an empty file)
  if (jobId && !(await db.get('SELECT 1 AS x FROM scan_jobs WHERE id = ? AND user_id = ?', [jobId, user.tenantId]))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // Default export is real leads only; ?include_fixtures=1 is the explicit opt-in
  // that keeps the verification fixture rows in the file.
  const includeFixtures = req.nextUrl.searchParams.get('include_fixtures') === '1'
  const unavailable = () => NextResponse.json({ error: 'Company First currentness cannot be verified on this database. No CSV was generated.' },
    { status: 503, headers: { 'cache-control': 'no-store' } })
  const marked = (budget: unknown) => hasCompanyFirstBudget(typeof budget === 'string' ? budget : null)
  if (db.kind !== 'sqlite' && jobId) {
    const job = await db.get<{run_budget:string|null}>('SELECT run_budget FROM scan_jobs WHERE id = ? AND user_id = ?', [jobId,user.tenantId])
    if (marked(job?.run_budget)) return unavailable()
  }
  const suppliedCursor=req.nextUrl.searchParams.get('cursor')
  const invalidCursor=()=>NextResponse.json({error:'Export cursor unavailable. Restart the export from the beginning.'},
    {status:409,headers:{'cache-control':'no-store'}})
  if(suppliedCursor!==null&&!/^[a-f0-9]{24}$/.test(suppliedCursor))return invalidCursor()
  const scope=jobId||undefined
  const anchor=suppliedCursor?await exportLeadCursor(db,user.tenantId,suppliedCursor,scope):null
  if(suppliedCursor&&!anchor)return invalidCursor()
  let after=anchor??undefined,lastRead:string|null=null,seen=0,more=false
  const at = new Date()
  const rows: Record<string,unknown>[] = []
  while(rows.length<EXPORT_ROW_LIMIT&&seen<EXPORT_WORK_LIMIT){
    const size=Math.min(EXPORT_BATCH,EXPORT_WORK_LIMIT-seen)
    const candidates=await exportLeadPage(db,user.tenantId,scope,size+1,includeFixtures,after)
    if(db.kind!=='sqlite'&&candidates.some(row=>marked(row.job_run_budget)))return unavailable()
    more=candidates.length>size
    const page=candidates.slice(0,size)
    const selected=new Map<string,string[]>()
    for(const row of page)if(marked(row.job_run_budget)&&typeof row.job_id==='string'&&typeof row.lead_id==='string'){
      const ids=selected.get(row.job_id)??[]
      ids.push(row.lead_id)
      selected.set(row.job_id,ids)
    }
    const gates=new Map<string,ReadonlySet<string>|null>()
    for(const [index,row] of page.entries()){
      seen++
      lastRead=typeof row.lead_id==='string'?row.lead_id:null
      after=parseExportLeadCursor(row.created_at,row.export_insert_seq)??undefined
      if(!after||!lastRead)return invalidCursor()
      if(!marked(row.job_run_budget))rows.push(row)
      else try{
        if(typeof row.job_id==='string'){
          if(!gates.has(row.job_id))gates.set(row.job_id,await requiredGateHeldForJob(db,user.tenantId,row.job_id,selected.get(row.job_id)??[]).catch(()=>null))
          const held=gates.get(row.job_id)
          if(held&&!await markedCurrentnessHeldDb(db,user.tenantId,row.job_id,lastRead,at,held))rows.push(row)
        }
      }catch{/* Unreadable current proof keeps a marked row out of the export. */}
      if(rows.length===EXPORT_ROW_LIMIT){
        // There may be unexamined rows in this batch even without a lookahead.
        more ||= index + 1 < page.length
        break
      }
    }
    if(!more)break
  }
  // Resume after the last examined row when either budget stops this page.
  // Do not advance over unchecked rows (or emit a cursor at true exhaustion).
  const next=more?lastRead:null
  const continuation = new URLSearchParams()
  if(jobId)continuation.set('job_id',jobId)
  if(includeFixtures)continuation.set('include_fixtures','1')
  if(next)continuation.set('cursor',next)
  const via = await readGdeltAttribution(db, user.tenantId, rows.map(r => String(r.lead_id)))
  const people = await bestPeople(db, user.tenantId, rows as { lead_id: string; job_id: string }[])
  const csv = toCsv(rows.map(r => ({ ...r, ...people.get(r.lead_id as string), discovered_via: via.get(String(r.lead_id))?.text ?? '', discovered_via_link: via.get(String(r.lead_id))?.link ?? '', evidence_origin_label: exportEvidenceOrigin(r as Parameters<typeof exportEvidenceOrigin>[0]), date_context: (() => { const lead = { intent: typeof r.intent === 'number' ? r.intent : null, event_date: typeof r.event_date === 'string' ? r.event_date : null, event_date_proof: typeof r.event_date_proof === 'string' ? r.event_date_proof : null, signal: typeof r.signal === 'string' ? r.signal : null, signal_kind: typeof r.signal_kind === 'string' ? r.signal_kind : null }; const w = jobWindowDays({ query: typeof r.job_query === 'string' ? r.job_query : null, icp: typeof r.job_icp === 'string' ? r.job_icp : null, run_budget: typeof r.job_run_budget === 'string' ? r.job_run_budget : null }); const o = { windowDays: w, timingRequired: w != null || TIMING_REQUESTED.test(typeof r.job_query === 'string' ? r.job_query : '') }; return eventDateCopy(lead.event_date, typeof r.date_status === 'string' ? r.date_status : null, surfaceStoredIntent(lead, o).timing, { dayVerified: eventDayVerified(lead), windowMissed: timingUnconfirmedReason(lead, o) === 'out_of_window' }) })(), created_at: typeof r.created_at === 'number' ? new Date(r.created_at * 1000).toISOString() : r.created_at })), COLUMNS)
  await audit(user, req, { action: 'export.leads', resource: jobId ? 'scan_job' : 'leads', id: jobId || null, summary: { rows: rows.length, fixtures: includeFixtures, ...(next ? { candidate_limit: EXPORT_WORK_LIMIT, truncated: true } : {}) } })
  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="dazl-leads${jobId ? `-${jobId}` : ''}.csv"`,
      'cache-control': 'no-store',
      ...(next ? { 'x-dazl-export-truncated': 'true', 'x-dazl-export-candidate-limit': String(EXPORT_WORK_LIMIT), 'x-dazl-export-next-cursor': next, link: `</api/leads/export?${continuation}>; rel="next"` } : {}),
    },
  })
}
