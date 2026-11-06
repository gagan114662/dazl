import { NextRequest, NextResponse } from 'next/server'
import { rateLimit } from '@/lib/rate-limit'
import { requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { denied } from '@/lib/workspace-access'
import { startScan } from '@/lib/scan/start-scan'

// Every gate after sign-in, role, rate limit and origin lives in lib/scan/start-scan.ts, shared with the scoped API (#392).
export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'operate'); if (no) return no

  const rl = (await rateLimit(`scan:${user.tenantId}`, 10, 60 * 60 * 1000))
  // the shared limit could not be checked: no scan and no trial admission (lib/rate-limit.ts fails closed)
  if (rl.unavailable) return NextResponse.json({ error: 'Scans are briefly unavailable. Try again in a moment.', code: 'limits_unavailable' }, { status: 503, headers: { 'Retry-After': String(rl.retryAfterS) } })
  if (!rl.ok) return NextResponse.json({ error: 'Too many scans. Try again later.' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterS) } })

  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  return startScan(user, body, req)
}
