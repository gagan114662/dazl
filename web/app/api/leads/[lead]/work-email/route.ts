import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { denied } from '@/lib/workspace-access'
import { findWorkEmail, strictPublishedWorkEmailsForLeads, PUBLISHED_ONLY_WORK_EMAIL_PROVIDERS } from '@/lib/people/work-email'
import { captureError } from '@/lib/ops/errors'
import { requestIdOf } from '@/lib/ops/request-log'

// #1036 Find work email for one buyer named on a lead (lib/people/work-email.ts): the address the company prints for that person on its
// own website. GET: the answer for each buyer on the lead. POST { target }: the answer for one. The person is re-derived on the server
// from the lead's stored rows; the body only names which one.
const LEAD_ID = /^[a-f0-9]{24}$/

export async function GET(_req: NextRequest, { params }: { params: Promise<{ lead: string }> }) {
  const { lead } = await params
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!LEAD_ID.test(lead)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const db = getScanDb()
  const own = db.prepare('SELECT 1 FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?').get(lead, user.tenantId)
  if (!own) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // #1036 / #1250: only an address the company prints on its own site; no stored provider answer, no guess.
  return NextResponse.json({ providers: PUBLISHED_ONLY_WORK_EMAIL_PROVIDERS, lookups: strictPublishedWorkEmailsForLeads(db, user.tenantId, [lead])[lead] ?? [], guesses: [] })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ lead: string }> }) {
  const { lead } = await params
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'operate'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad origin' }, { status: 403 })
  if (!LEAD_ID.test(lead)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Send JSON: { "target": "<name>|<title>" }' }, { status: 400 }) }
  const target = body && typeof body === 'object' && !Array.isArray(body) ? (body as { target?: unknown }).target : undefined
  if (typeof target !== 'string' || !target || target.length > 200) return NextResponse.json({ error: 'Pick a person on this lead' }, { status: 400 })
  if (!(await rateLimit(`work-email:${user.tenantId}`, 20, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const db = getScanDb()
  let r: Awaited<ReturnType<typeof findWorkEmail>>
  try { r = await findWorkEmail(db, user.tenantId, lead, target) }
  catch (e) {
    captureError(e, { source: 'route', where: '/api/leads/[lead]/work-email', method: 'POST', tenantId: user.tenantId, requestId: requestIdOf(req) })
    return NextResponse.json({ error: 'The lookup could not run; try again.' }, { status: 500 })
  }
  if (r.status === 'lead_not_found') return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
  if (r.status === 'not_eligible' || r.status === 'site_unsettled') return NextResponse.json({ error: r.detail, status: r.status }, { status: 422 })
  if (!('row' in r)) return NextResponse.json({ error: r.detail, status: r.status }, { status: 422 })
  return NextResponse.json({ status: r.status, lookup: r.row, replayed: r.replayed })
}
