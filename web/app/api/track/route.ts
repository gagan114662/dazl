import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { CLIENT_EVENTS, funnelProps, track, type ClientEvent, type FunnelProps } from '@/lib/analytics/track'

// The funnel steps only the browser knows (#1616, lib/analytics/track-client.ts). Signed-in and same-origin only; the
// account comes from the session, never from the body; the event must be one of CLIENT_EVENTS and its properties must
// pass the allowlist (lib/analytics/track.ts), or nothing is recorded. Always answers without a body.
export async function POST(req: NextRequest) {
  if (!sameOriginJson(req) || !req.headers.get('origin')) return new NextResponse(null, { status: 403 })
  if (Number(req.headers.get('content-length') ?? 0) > 1024) return new NextResponse(null, { status: 413 })
  const user = await requireUser()
  if (!user) return new NextResponse(null, { status: 401 })
  if (!(await rateLimit(`track:${user.tenantId}`, 120, 10 * 60 * 1000)).ok) return new NextResponse(null, { status: 429 })
  const body = await req.json().catch(() => null)
  if (!CLIENT_EVENTS.includes(body?.event)) return new NextResponse(null, { status: 400 })
  let props: FunnelProps
  try { props = funnelProps(body.props) } catch { return new NextResponse(null, { status: 400 }) }
  track(body.event as ClientEvent, user.tenantId, props)
  return new NextResponse(null, { status: 204 })
}
