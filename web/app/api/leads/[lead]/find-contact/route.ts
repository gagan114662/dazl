import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { findContactForConfirmedLead } from '@/lib/scan/find-contact'
import { denied } from '@/lib/workspace-access'

// User-requested public contact-page search for one lead they confirmed. Free, robots-obeying,
// no AI, no email. See lib/scan/find-contact.ts.
export async function POST(req: NextRequest, { params }: { params: Promise<{ lead: string }> }) {
  const { lead } = await params
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = await denied(user, 'operate'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad origin' }, { status: 403 })
  if (!/^[a-f0-9]{24}$/.test(lead)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!(await rateLimit(`find-contact:${user.tenantId}`, 10, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const r = await findContactForConfirmedLead(getScanDb(), user.tenantId, lead, { signal: AbortSignal.timeout(60_000) })
  if (r.status === 'not_found') return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
  if (r.status === 'not_confirmed') return NextResponse.json({ error: 'Confirm the lead first' }, { status: 409 })
  if (r.status === 'not_company') return NextResponse.json({ error: 'This row has no company website to search' }, { status: 422 })
  if (r.status === 'disabled') return NextResponse.json({ error: 'Contact search is turned off' }, { status: 503 })
  return NextResponse.json({ searched: true, found: r.contacts })
}
