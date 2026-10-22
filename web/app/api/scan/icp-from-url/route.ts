import { NextRequest, NextResponse } from 'next/server'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { icpFromWebsite } from '@/lib/scan/icp-from-site'

// Turns the user's own homepage into an editable ICP draft (returned, never saved).
// Tight rate limit: it fetches an arbitrary URL server-side and makes an LLM call.
export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const rl = rateLimit(`icpurl:${user.id}`, 5, 60 * 60 * 1000)
  if (!rl.ok) return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterS) } })
  const body = await req.json().catch(() => null)
  let url = typeof body?.url === 'string' ? body.url.trim().slice(0, 300) : ''
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`
  if (url.length < 5) return NextResponse.json({ error: 'invalid' }, { status: 400 })
  const out = await icpFromWebsite(getScanDb(), user.id, url)
  if ('error' in out) {
    const status = out.error === 'no_api_key' || out.error === 'key_unreadable' || out.error === 'invalid' || out.error === 'not_public' ? 400
      : out.error === 'js_only' || out.error === 'not_html' ? 422 : 502
    return NextResponse.json({ error: out.error }, { status })
  }
  return NextResponse.json(out)
}
