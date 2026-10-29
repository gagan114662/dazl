import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { createDraft, listMessages, OutreachError } from '@/lib/outreach/service'
import { draftFailure } from '@/lib/outreach/draft-error'
import { captureError } from '@/lib/ops/errors'
import { requestIdOf } from '@/lib/ops/request-log'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'

const MSG: Record<string, [number, string]> = {
  domain_unconfirmed: [409, 'Check that this website is the right company on Leads ("This website is the right company") before drafting. That check is not need, consent or a send approval.'],
  seller_context_required: [422, 'Add your business name on the Home page ("What you sell") before creating a draft.'],
  offer_unreadable: [503, 'What this play sells could not be read just now, so nothing was drafted. Try again in a moment.'],
  offer_conflict: [409, 'This play\'s request names a different offer than the one it was created with. Choose what this play sells on its campaign page (or Home) before drafting.'],
  seller_offer_required: [422, 'Add a short description of what you offer (Memory or onboarding) before creating a draft. dazl will not invent one.'],
  sales_hiring_check_failed: [409, 'The required sales-hiring check failed for this lead, so it cannot be drafted or sent. Confirming the lead or its website does not clear it; run the scan again.'],
  lead_currentness_unconfirmed: [409, 'This is quote-backed research with unknown event timing. Review the source on Leads before using it for drafting; that is not a freshness or consent verdict.'],
  not_found: [404, 'Lead not found'],
  lead_not_verified: [422, 'Only leads verified by dazl can be emailed'],
  no_email_contact: [422, 'This lead has no published email address'],
  not_sales_contact: [422, 'The only published address is a recruitment, press, support, privacy or other restricted-purpose inbox - not a sales contact'],
  personal_email: [422, 'This is a personal email address (Gmail, Yahoo, etc.), so dazl will not email it'],
  lead_ungraded: [422, 'This lead could not be ICP-graded (scoring failed), so it cannot be emailed. Re-run the scan to grade it.'],
  suppressed: [409, 'This address unsubscribed or is on your suppression list'],
  already_drafted: [409, 'A draft for this lead already exists'],
}

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  return NextResponse.json({ messages: listMessages(getScanDb(), user.id) })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!(await rateLimit(`draft:${user.id}`, 60, 60 * 60 * 1000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const body = await req.json().catch(() => null)
  if (typeof body?.lead_id !== 'string' || !/^[a-f0-9]{24}$/.test(body.lead_id)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  try {
    const id = createDraft(getScanDb(), user.id, body.lead_id, user.business_name)
    // Drafts are template-only here: an LLM rewrite bills the tenant's provider key,
    // so it happens only via an explicit click on POST /api/outreach/polish.
    return NextResponse.json({ id }, { status: 201 })
  } catch (e) {
    if (e instanceof OutreachError) { const [s, m] = MSG[e.code] ?? [400, 'Could not create the draft']; return NextResponse.json({ error: m, code: e.code }, { status: s }) }
    // Not a known business refusal (for example SQLITE_BUSY under a second writer). Fixed body, so the client always gets JSON.
    const f = draftFailure(e)
    captureError(e, { source: 'route', where: '/api/outreach', method: 'POST', tenantId: user.id, requestId: requestIdOf(req) })
    return NextResponse.json(f.body, { status: f.status })
  }
}
