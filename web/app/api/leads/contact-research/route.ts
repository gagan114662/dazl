import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { denied } from '@/lib/workspace-access'
import { isStaging } from '@/lib/staging'
import { readTenantKey } from '@/lib/llm/key-store'
import { anthropicWithModel, providers, ProviderError } from '@/lib/llm/provider'
import { spendAccountingFailed, spendRefused } from '@/lib/llm/owner-guard'
import { CONTACT_RESEARCH_MODEL, listedCostUsd, readResearchInput, researchContact } from '@/lib/people/contact-research'

// TEST-ONLY, staging only (#1102): run the named-contact lookup (lib/people/contact-research.ts) once for a company the caller
// types, so its hit rate, precision and cost can be measured on real companies before it is wired into "Find contact". It
// stores nothing on any lead. It spends for real: TinyFish searches under the tenant's daily cap, and one model call on the
// signed-in account's own Anthropic key inside that account's spend limits (the lookup calls through the owner guard). Outside staging a signed-in member
// with the operate role gets 404 before the body is read (signed out is 401 and a viewer 403, like every session route).
const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404 })

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'operate'); if (no) return no
  if (!isStaging()) return notFound()
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad origin' }, { status: 403 })
  if (!(await rateLimit(`contact-research:${user.tenantId}`, 20, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const raw = await req.text().catch(() => '')
  if (raw.length > 2000) return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  let body: unknown = null
  try { body = JSON.parse(raw) } catch { /* handled below */ }
  const read = readResearchInput(body)
  if (!read) return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  const db = await getDb()
  // The account's own Anthropic key only: the lookup is priced for the two Claude models named below.
  const k = await readTenantKey(db, user.tenantId, 'anthropic')
  if (!k.key) return NextResponse.json({ error: k.unreadable ? 'key_unreadable' : 'anthropic_key_required' }, { status: 409 })
  // "haiku" (the default) asks for Haiku; "default" asks for the deployment's own model. The caller chooses; nothing falls back by itself.
  // The lookup itself calls it through the owner guard (the account's spend limits).
  const provider = read.model === 'default' ? providers.anthropic : anthropicWithModel(CONTACT_RESEARCH_MODEL)
  try {
    // The 60 s bound covers the searches and the page read; the model call has its own timeout (lib/llm/provider.ts LLM_TIMEOUT_MS).
    const r = await researchContact(read.input, { db, tenantId: user.tenantId, provider, apiKey: k.key, signal: AbortSignal.timeout(60_000) })
    // cost_usd_listed: the MODEL call only, at the vendor's list price. The spend guards reserve Haiku at a higher price on purpose, so the
    // account's spend-limit usage reads higher than this; TinyFish searches are counted by number (the tenant's daily cap), not in dollars.
    return NextResponse.json({ ...r, cost_usd_listed: listedCostUsd(r.usage) }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    // A call may have been made and billed but its cost could not be recorded: the account's later calls are refused until it is settled.
    if (spendAccountingFailed(e)) return NextResponse.json({ error: 'accounting_pending' }, { status: 503 })
    // Refused BEFORE any model call: nothing was charged for the model (the searches already ran and are counted).
    if (spendRefused(e)) return NextResponse.json({ error: e.reason === 'model_unpriced' ? 'model_unpriced' : e.reason === 'over_limit' || e.reason === 'owner_pool_limit' ? 'spend_limit' : 'spend_unavailable' }, { status: 409 })
    if (e instanceof ProviderError) return NextResponse.json({ error: e.kind === 'auth' ? 'key_rejected' : 'provider_failed' }, { status: 502 })
    throw e
  }
}
