import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { setDomainReview } from '@/lib/scan/domain-review-action'
import { denied } from '@/lib/workspace-access'

// The user records (or withdraws) that the website behind a crawled address is the right company.
// Not need, consent or a send approval. See lib/outreach/domain-review.ts.
export async function POST(req: NextRequest, { params }: { params: Promise<{ lead: string }> }) {
  const { lead } = await params
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = await denied(user, 'operate'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad origin' }, { status: 403 })
  if (!/^[a-f0-9]{24}$/.test(lead)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!(await rateLimit(`domain-review:${user.tenantId}`, 30, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  let action: unknown; let binding: unknown
  try { const b = await req.json(); action = b?.action; binding = b?.binding } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }) }
  if (action !== 'confirm' && action !== 'withdraw') return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (action === 'confirm' && !(typeof binding === 'string' && /^[a-f0-9]{64}$/.test(binding))) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const r = setDomainReview(getScanDb(), user.tenantId, lead, action, typeof binding === 'string' ? binding : undefined)
  if (r.status === 'not_found') return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
  if (r.status === 'not_required') return NextResponse.json({ error: 'No website check is needed for this lead' }, { status: 409 })
  if (r.status === 'stale') return NextResponse.json({ error: 'This lead changed since you loaded the page. It was reloaded, so check the website again.', stale: true }, { status: 409 })
  return NextResponse.json(r)
}
