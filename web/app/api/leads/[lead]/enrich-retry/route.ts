import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { retryHeldEnrichment } from '@/lib/enrich/index'
import { denied } from '@/lib/workspace-access'

// The owner's explicit retry of ONE held enrichment lookup (a rate limit or crash left the outcome unknown).
// The body names the exact provider+step the owner clicked on, and the release + re-run are scoped to it: the
// cost and limits shown next to that item (GET /api/enrich/held -> costText) are the whole scope of this call -
// an Apollo retry never releases or runs PDL. The claim release is guarded (reserved-only, age-gated) and
// disclosure-audited; nothing here runs automatically.
export async function POST(req: NextRequest, { params }: { params: Promise<{ lead: string }> }) {
  const { lead } = await params
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'operate'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad origin' }, { status: 403 })
  if (!/^[a-f0-9]{24}$/.test(lead)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!(await rateLimit(`enrich-retry:${user.tenantId}`, 5, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  let selector: { provider: 'apollo' | 'pdl'; step: 'org' | 'people' | 'legacy' }
  try {
    const b = await req.json() as { provider?: unknown; step?: unknown }
    if ((b.provider !== 'apollo' && b.provider !== 'pdl') || (b.step !== 'org' && b.step !== 'people' && b.step !== 'legacy')) return NextResponse.json({ error: 'Pick one interrupted lookup to retry' }, { status: 400 })
    selector = { provider: b.provider, step: b.step }
  } catch { return NextResponse.json({ error: 'Pick one interrupted lookup to retry' }, { status: 400 }) }
  const r = await retryHeldEnrichment(getScanDb(), user.tenantId, lead, selector)
  if (r.status !== 'retried') return NextResponse.json({ error: r.status === 'not_found' ? 'Lead not found' : 'No interrupted lookup to retry' }, { status: r.status === 'not_found' ? 404 : 409 })
  return NextResponse.json({ retried: true, attached: r.attached, releases: r.releases })
}
