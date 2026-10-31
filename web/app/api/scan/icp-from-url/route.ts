import { NextRequest, NextResponse } from 'next/server'
import { sameOriginJson } from '@/lib/same-origin'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { getDb } from '@/lib/db/client'
import { admitWorkspaceSiteRead } from '@/lib/scan/trial-site-read'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { icpFromWebsite } from '@/lib/scan/icp-from-site'
import { denied } from '@/lib/workspace-access'

// Turns the user's own homepage into an editable ICP draft (returned, never saved).
// Tight rate limit: it fetches an arbitrary URL server-side and makes an LLM call. Without the user's own key the call may
// run on the trial key, admitted per read and bounded (lib/scan/trial-site-read.ts); otherwise the refusal reason is
// returned with no_api_key so the page can say why and offer the key or the manual profile. The trial is the workspace
// founder's own account, read on the server and only while that account acts (lib/billing/trial-budget.ts
// trialPrincipal), as for scans: another member's email or Google sign-in never makes a workspace eligible.
export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'operate'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const rl = (await rateLimit(`icpurl:${user.tenantId}`, 5, 60 * 60 * 1000))
  if (!rl.ok) return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterS) } })
  const body = await req.json().catch(() => null)
  let url = typeof body?.url === 'string' ? body.url.trim().slice(0, 300) : ''
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`
  if (url.length < 5) return NextResponse.json({ error: 'invalid' }, { status: 400 })
  const out = await icpFromWebsite(getScanDb(), user.tenantId, url, { trial: async () => admitWorkspaceSiteRead(await getDb(), user, clientIp(req)) })
  if ('error' in out) {
    if (out.error === 'spend_limit') return NextResponse.json({ error: 'spend_limit', message: 'Your workspace AI spend limit for today or this month is reached, so nothing was generated and nothing was charged.' }, { status: 429 })
    const status = out.error === 'no_api_key' || out.error === 'key_unreadable' || out.error === 'invalid' || out.error === 'not_public' ? 400
      : out.error === 'js_only' || out.error === 'not_html' ? 422 : 502
    return NextResponse.json({ error: out.error, ...(out.trial ? { trial: out.trial } : {}) }, { status })
  }
  return NextResponse.json(out)
}
