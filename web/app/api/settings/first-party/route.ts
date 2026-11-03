import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { audit } from '@/lib/audit-route'
import { denied, stale } from '@/lib/workspace-access'
import { configStatus, eraseFirstParty, parseConfigInput, recordConfig, setCollection } from '@/lib/signals/first-party'

// #390: the tenant's first-party signal setup. GET: status (never the secret). POST actions:
//   record  {site_domain, basis: 'consent', privacy_url, retention_days} - records the consent basis and turns collection on
//           with a NEW signing secret, returned once
//   disable - opt-out: collection stops; stored events stay until their retention ends or `erase`
//   enable  - collection back on under the recorded basis
//   erase   - deletes every first-party lead, event and the config (secret included)
export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  return NextResponse.json({
    ...(await configStatus(await getDb(), user.tenantId)),
    endpoint: `${(process.env.PUBLIC_BASE_URL || req.nextUrl.origin).replace(/\/$/, '')}/api/hooks/first-party?u=${encodeURIComponent(user.tenantId)}`,
  })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'configure'); if (no) return no
  const old = stale(user); if (old) return old
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!(await rateLimit(`first-party-cfg:${user.tenantId}`, 10, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const body = await req.json().catch(() => null) as { action?: unknown } | null
  const db = await getDb()
  if (body?.action === 'record') {
    const input = parseConfigInput(body)
    if ('error' in input) return NextResponse.json({ error: input.error }, { status: 400 })
    const secret = await recordConfig(db, user.tenantId, input, user.actorId)
    await audit(user, req, { action: 'consent.accepted', resource: 'first_party', summary: { basis: input.basis, site_domain: input.site_domain, retention_days: input.retention_days } })
    return NextResponse.json({ ok: true, secret, ...(await configStatus(db, user.tenantId)) })
  }
  if (body?.action === 'disable' || body?.action === 'enable') {
    const on = body.action === 'enable'
    const changed = await setCollection(db, user.tenantId, on)
    if (changed) await audit(user, req, { action: on ? 'connector.enabled' : 'connector.disabled', resource: 'first_party' })
    return NextResponse.json({ ok: true, changed, ...(await configStatus(db, user.tenantId)) })
  }
  if (body?.action === 'erase') {
    const leads = await eraseFirstParty(db, user.tenantId)
    await audit(user, req, { action: 'data.erased', resource: 'first_party', summary: { leads } })
    return NextResponse.json({ ok: true, erased_leads: leads, ...(await configStatus(db, user.tenantId)) })
  }
  return NextResponse.json({ error: 'Bad request' }, { status: 400 })
}
