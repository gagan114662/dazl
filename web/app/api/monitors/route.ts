import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { cleanText } from '@/lib/validate'
import { MAX_QUERY, normalizeIcp } from '@/lib/scan/icp'
import { normalizeSources } from '@/lib/sources'
import { createMonitor, listMonitors } from '@/lib/monitors'
import { denied } from '@/lib/workspace-access'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  return NextResponse.json({ monitors: await listMonitors(await getDb(), user.tenantId) })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'operate'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  const query = cleanText(body?.query, MAX_QUERY)
  if (query.length < 3) return NextResponse.json({ error: 'Describe what to monitor' }, { status: 400 })
  const icp = body?.icp === undefined || body?.icp === null ? null : normalizeIcp(body.icp)
  if (body?.icp !== undefined && body?.icp !== null && !icp) return NextResponse.json({ error: 'The profile needs a summary' }, { status: 400 })
  const sel = body?.sources ? normalizeSources(body.sources) : null
  const intervalHours = typeof body?.interval_hours === 'number' ? body.interval_hours : undefined
  const r = await createMonitor(await getDb(), user.tenantId, { query, icp: icp ? JSON.stringify(icp) : null, sources: sel ? JSON.stringify(sel) : null, intervalHours })
  if ('error' in r) return NextResponse.json(
    r.error === 'limit' ? { error: 'monitor_limit', limit: r.limit } : { error: 'interval_too_short', min: r.min },
    { status: 400 },
  )
  return NextResponse.json({ id: r.id }, { status: 201 })
}
