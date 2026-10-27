import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { evidenceCopyForLead } from '@/lib/scan/evidence-copies'
import { evidenceOriginLabel, COPY_ORIGIN } from '@/lib/scan/evidence-origin'

// The preserved original text a lead was verified against (only for leads checked against a TinyFish copy). Tenant-scoped through
// the lead's job; expired, missing and foreign records are all the same 404.
export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const leadId = req.nextUrl.searchParams.get('lead_id') ?? ''
  if (!/^[a-f0-9]{24}$/.test(leadId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const c = evidenceCopyForLead(getScanDb(), user.id, leadId)
  if (!c) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ...c, origin: COPY_ORIGIN, label: evidenceOriginLabel(COPY_ORIGIN, c.own_fetch_failure), note: 'Text as received from TinyFish and checked by dazl. dazl did not read the page directly.' }, { headers: { 'cache-control': 'no-store' } })
}
