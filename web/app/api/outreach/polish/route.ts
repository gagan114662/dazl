import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { polishDraft } from '@/lib/outreach/draft-llm'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'

// Explicit, per-draft AI rewrite. This is the ONLY user-facing path that runs the
// polish: it bills the tenant's own provider key, so it needs its own click every
// time - nothing here implies standing permission, and draft creation never calls it.
export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!rateLimit(`polish:${user.id}`, 30, 60 * 60 * 1000).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const body = await req.json().catch(() => null)
  if (typeof body?.message_id !== 'string' || !/^[a-f0-9]{24}$/.test(body.message_id)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const r = await polishDraft(getScanDb(), user.id, body.message_id, user.business_name)
  if (!r.rewritten) {
    const note = {
      no_key: 'No AI key on file - add one in Settings to use the rewrite.',
      no_profile: 'Add what you sell (positioning) in Settings first - without it the rewrite would have to invent an offer.',
      unusable: 'The rewrite came back unusable - the original draft is unchanged.',
      blocked_claim: 'The rewrite asserted an unverified claim, so it was discarded - the original draft is unchanged.',
      error: 'The rewrite failed - the original draft is unchanged.',
    }[r.reason]
    return NextResponse.json({ rewritten: false, reason: r.reason, note })
  }
  return NextResponse.json({ rewritten: true, vendor: r.vendor })
}
