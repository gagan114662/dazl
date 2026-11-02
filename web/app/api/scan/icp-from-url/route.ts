import { captureError } from '@/lib/ops/errors'
import { requestIdOf } from '@/lib/ops/request-log'
import { recallSellerDecisions, siteKey } from '@/lib/scan/intelligence'
import { sqliteDb } from '@/lib/db/client'
import { NextRequest, NextResponse } from 'next/server'
import { sameOriginJson } from '@/lib/same-origin'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { admitTrialSiteRead } from '@/lib/scan/trial-site-read'
import { trialPrincipal } from '@/lib/billing/trial-budget'
import { hasKey } from '@/lib/llm/key-store'
import { icpFromWebsite } from '@/lib/scan/icp-from-site'
import { latestQueryJob } from '@/lib/scan/store'
import { denied } from '@/lib/workspace-access'

// Turns the user's own homepage into an editable ICP draft (returned, never saved).
// Tight rate limit: it fetches an arbitrary URL server-side and makes an LLM call. Without the user's own key the call
// may run on the trial key, admitted per read and bounded (lib/scan/trial-site-read.ts); a refusal there never hides the
// free read - the page gets the extracted facts with the reason and the manual path (#409). The trial is the workspace
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
  if (url.length < 5 || !siteKey(url)) return NextResponse.json({ error: 'invalid' }, { status: 400 })
  // Prior research carries the answered-question binding and reviewed corrections into a recrawl (#379) - only for
  // the SAME site (double-guard on the submitted URL's host; buildResearch re-checks against the fetched final URL).
  let prior = null
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
    const prev = latestQueryJob(getScanDb(), user.tenantId)
    let pj: unknown = null; try { pj = prev?.icp ? JSON.parse(prev.icp) : null } catch { pj = null }
    const pr = pj && typeof pj === 'object' ? (pj as { research?: { site?: unknown } | null }).research : null
    prior = pr && typeof pr === 'object' && pr.site === host ? (pr as never) : null
  } catch { prior = null }
  // Scan admission still owns the SQLite store, even in mixed mode. Read the SAME authoritative store;
  // do not read an empty PG ledger while scans continue to write SQLite. The core also runs on Db/PG.
  // A failed recall is not empty memory: refuse before any fetch/model call so corrections cannot silently vanish.
  let decisions
  try { decisions = await recallSellerDecisions(sqliteDb(getScanDb()), user.tenantId, url) }
  catch (e) {
    captureError(e, { source: 'route', where: '/api/scan/icp-from-url', method: 'POST', tenantId: user.tenantId, requestId: requestIdOf(req) })
    return NextResponse.json({ error: 'intelligence_unavailable', message: 'Saved targeting decisions could not be read. Try again before generating a new profile.' }, { status: 503 })
  }
  if (decisions.trace.truncated) return NextResponse.json({ error: 'intelligence_capacity', message: 'Saved targeting exceeds the safe recall window. No new profile was generated; use your existing reviewed profile.' }, { status: 409 })
  // Without a key of its own, the workspace's trial principal is read BEFORE any fetch (cheap, counts nothing): a member,
  // a team workspace or a workspace without its founder's row has no trial path, so the read is the free one. The
  // admission itself (eligibility, counters, wallet) still runs only after the page was fetched and found readable.
  const db = getScanDb()
  const principal = hasKey(db, user.tenantId) ? null : await trialPrincipal(await getDb(), user)
  const trial = principal ? (() => getDb().then(d => admitTrialSiteRead(d, principal, clientIp(req)))) : undefined
  const out = await icpFromWebsite(db, user.tenantId, url, { prior, decisions, ...(trial ? { trial } : {}) })
  if ('error' in out) {
    if (out.error === 'spend_limit') return NextResponse.json({ error: 'spend_limit', message: 'Your workspace AI spend limit for today or this month is reached, so nothing was generated and nothing was charged.' }, { status: 429 })
    if (out.error === 'model_unpriced') return NextResponse.json({ error: 'model_unpriced', message: 'The AI model configured for this workspace has no price bound, so the read was refused before it ran. Nothing was charged.' }, { status: 503 })
    if (out.error === 'accounting_pending') return NextResponse.json({ error: 'accounting_pending', message: 'The cost of an earlier AI call could not be recorded, so paid generation is paused until that record settles. That call may still be billed to your key; no new charge was made for this request.' }, { status: 503 })
    if (out.error === 'spend_unavailable') return NextResponse.json({ error: 'spend_unavailable', message: 'Your spend budget could not be checked just now, so nothing was generated and nothing was charged. Try again shortly.' }, { status: 503 })
    const status = out.error === 'no_api_key' || out.error === 'key_unreadable' || out.error === 'invalid' || out.error === 'not_public' ? 400
      : out.error === 'js_only' || out.error === 'not_html' ? 422 : 502
    return NextResponse.json({ error: out.error, ...('trial' in out && out.trial ? { trial: out.trial } : {}) }, { status })
  }
  return NextResponse.json({ ...out, intelligence: decisions.trace })
}
