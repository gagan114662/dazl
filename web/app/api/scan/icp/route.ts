import { NextRequest, NextResponse } from 'next/server'
import { cleanText } from '@/lib/validate'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { sameOriginJson } from '@/lib/same-origin'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { previewIcp } from '@/lib/scan/runner'
import { MAX_QUERY } from '@/lib/scan/icp'

// Turns "what are you looking for" into an editable profile, using the caller's own key.
export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const rl = rateLimit(`icp:${user.id}`, 30, 60 * 60 * 1000)
  if (!rl.ok) return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterS) } })
  const body = await req.json().catch(() => null)
  const query = cleanText(body?.query, MAX_QUERY)
  if (query.length < 3) return NextResponse.json({ error: 'Describe who you are looking for' }, { status: 400 })
  const out = await previewIcp(getScanDb(), user.id, query, {}, clientIp(req))
  if ('error' in out) return NextResponse.json({ error: out.error }, { status: out.error === 'no_api_key' ? 400 : 402 })
  return NextResponse.json(out)
}
