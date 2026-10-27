import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { recentAudits, runAudit } from '@/lib/seo/audit'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  return NextResponse.json({ audits: recentAudits(getScanDb(), user.id) })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!(await rateLimit(`seo:${user.id}`, 10, 60 * 60 * 1000)).ok) return NextResponse.json({ error: 'Too many audits - try again in an hour.' }, { status: 429 })
  const body = await req.json().catch(() => null)
  if (typeof body?.domain !== 'string' || body.domain.length > 300) return NextResponse.json({ error: 'Enter a domain like acme.com.' }, { status: 400 })
  const r = await runAudit(getScanDb(), user.id, body.domain)
  if ('error' in r && !('checks' in r)) return NextResponse.json({ error: r.error }, { status: 400 })
  return NextResponse.json(r)
}
