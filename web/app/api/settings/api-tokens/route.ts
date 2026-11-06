import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { rateLimit } from '@/lib/rate-limit'
import { sameOriginJson } from '@/lib/same-origin'
import { denied, stale } from '@/lib/workspace-access'
import { audit } from '@/lib/audit-route'
import { apiEnabled, createToken, listTokens, MAX_ACTIVE_TOKENS, parseTokenSpec, revokeToken } from '@/lib/api-tokens'

// The workspace's API tokens for the scoped discovery API (#392, lib/api-tokens.ts, app/api/mcp). Admins manage them
// (configure); creating one also needs a fresh sign-in, like every other secret. The secret is shown once, in the
// creation response, and is never stored, listed or audited. Listing and revoking work even while the API is off.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'configure'); if (no) return no
  return NextResponse.json({ enabled: apiEnabled(), tokens: await listTokens(await getDb(), user.tenantId) })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'configure'); if (no) return no
  const old = stale(user); if (old) return old
  if (!apiEnabled()) return NextResponse.json({ error: 'api_disabled' }, { status: 404 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const rl = await rateLimit(`api-token:${user.tenantId}`, 20, 60 * 60 * 1000)
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterS) } })
  const parsed = parseTokenSpec(await req.json().catch(() => null))
  if (!parsed.ok) return NextResponse.json({ error: 'invalid_token_spec', detail: parsed.error }, { status: 400 })
  const t = await createToken(await getDb(), user.tenantId, user.actorId, parsed.spec)
  if (!t) return NextResponse.json({ error: 'too_many_tokens', max: MAX_ACTIVE_TOKENS }, { status: 409 })
  await audit(user, req, { action: 'api_token.created', resource: 'api_token', id: t.id, summary: { scopes: t.scopes.join(' '), scans_per_day: t.scans_per_day, max_usd_per_scan: t.max_usd_per_scan, expires_at: t.expires_at } })
  return NextResponse.json(t, { status: 201, headers: { 'Cache-Control': 'no-store' } })
}

// ?id=<public id>: revokes it at once, on every instance. Another workspace's id answers 404, the same as an unknown one.
export async function DELETE(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'configure'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const id = req.nextUrl.searchParams.get('id') ?? ''
  if (!await revokeToken(await getDb(), user.tenantId, id, user.actorId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await audit(user, req, { action: 'api_token.revoked', resource: 'api_token', id })
  return NextResponse.json({ ok: true })
}
