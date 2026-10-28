import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { addUserReportedPath, removeUserReportedPath, warmPathsForLead } from '@/lib/warm/connections'

// Warm paths to one lead's contacts. Degrees are labelled honestly: first_degree comes
// only from the user's own imported connections; user_reported entries are mutuals the
// user saw and typed in themselves - dazl does not verify them.

async function guard(req: NextRequest, leadId: string) {
  const user = await requireUser()
  if (!user) return { res: NextResponse.json({ error: 'Not signed in' }, { status: 401 }) }
  if (req.method !== 'GET' && !sameOriginJson(req)) return { res: NextResponse.json({ error: 'Bad origin' }, { status: 403 }) }
  if (!/^[a-f0-9]{24}$/.test(leadId)) return { res: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  return { user }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ lead: string }> }) {
  const { lead } = await params
  const g = await guard(req, lead)
  if (g.res) return g.res
  return NextResponse.json(warmPathsForLead(getScanDb(), g.user!.id, lead))
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ lead: string }> }) {
  const { lead } = await params
  const g = await guard(req, lead)
  if (g.res) return g.res
  if (!(await rateLimit(`warm-report:${g.user!.id}`, 20, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const body = await req.json().catch(() => null) as { contact_url?: string; mutual_name?: string; note?: string } | null
  if (!body || typeof body.contact_url !== 'string' || typeof body.mutual_name !== 'string') return NextResponse.json({ error: 'contact_url_and_mutual_name_required' }, { status: 400 })
  const path = addUserReportedPath(getScanDb(), g.user!.id, lead, body.contact_url, body.mutual_name, body.note)
  if (!path) return NextResponse.json({ error: 'invalid_contact_url_or_name' }, { status: 422 })
  return NextResponse.json({ path, provenance: 'user_reported' })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ lead: string }> }) {
  const { lead } = await params
  const g = await guard(req, lead)
  if (g.res) return g.res
  const body = await req.json().catch(() => null) as { id?: string } | null
  if (!body || typeof body.id !== 'string') return NextResponse.json({ error: 'id_required' }, { status: 400 })
  return NextResponse.json({ deleted: removeUserReportedPath(getScanDb(), g.user!.id, body.id) })
}
