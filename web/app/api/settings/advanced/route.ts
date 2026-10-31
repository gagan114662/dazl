import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { writeCredential, removeCredential, connectorStatus, setEnabled } from '@/lib/connectors/store'
import { writeConsent, readConsent, removeConsent } from '@/lib/advanced'
import { advFlags, UI_PLATFORMS, connectorId, CONSENT_VERSION, isAdvPlatform, platformAllowed, scopeFor } from '@/lib/advanced/config'
import { tinyfishEnabled } from '@/lib/search/tinyfish'
import { rateLimit } from '@/lib/rate-limit'
import { sameOriginJson } from '@/lib/same-origin'
import { audit } from '@/lib/audit-route'
import { denied, stale } from '@/lib/workspace-access'

// Status never includes a credential. When the operator has not enabled the tier, it reports available: false.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = await getDb()
  const f = advFlags()
  const st = await connectorStatus(db, user.tenantId)
  return NextResponse.json({
    available: f.enabled, version: CONSENT_VERSION,
    // The three platforms the UI offers. allowed = the operator has switched it on for this server.
    platforms: await Promise.all(UI_PLATFORMS.map(async p => {
      const c = st.find(x => x.connector === connectorId(p))
      // X needs no session when the operator key is set (TinyFish public-index path): expose that as
      // operator_index so the UI can offer the checkbox on consent alone, matching collectAdvanced.
      const operatorIndex = p === 'x' && tinyfishEnabled() && platformAllowed(p, f)
      return { platform: p, allowed: platformAllowed(p, f), consent: await readConsent(db, user.tenantId, scopeFor(p)), connected: !!c, enabled: !!c?.enabled, operator_index: operatorIndex, last4: c?.last4 ?? null, high_risk: p === 'linkedin' }
    })),
  })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'configure'); if (no) return no
  const old = stale(user); if (old) return old

  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  const f = advFlags()
  if (!isAdvPlatform(body?.platform) || !platformAllowed(body.platform, f)) return NextResponse.json({ error: 'Not available' }, { status: 404 })
  const db = await getDb()
  const p = body.platform
  if (body.action === 'consent') {
    if (body.accept !== true || body.version !== CONSENT_VERSION) return NextResponse.json({ error: 'Consent not recorded' }, { status: 400 })
    await writeConsent(db, user.tenantId, scopeFor(p))
    await audit(user, req, { action: 'consent.accepted', resource: 'social', id: p, summary: { platform: p, version: CONSENT_VERSION } })
    return NextResponse.json({ ok: true })
  }
  if (body.action === 'revoke') {
    // each change revoke makes is recorded on its own: the notice removed (any version; several platforms share one),
    // and this platform's channel turned off if it was on. A revoke that changes neither records nothing.
    const on = (await db.get<{ enabled: number }>('SELECT enabled FROM tenant_connectors WHERE tenant_id = ? AND connector = ?', [user.tenantId, connectorId(p)]))?.enabled === 1
    const removed = await removeConsent(db, user.tenantId, scopeFor(p))
    await setEnabled(db, user.tenantId, connectorId(p), false)
    if (removed) await audit(user, req, { action: 'consent.revoked', resource: 'social', id: p, summary: { platform: p } })
    if (on) await audit(user, req, { action: 'connector.disabled', resource: 'social', id: p, summary: { platform: p } })
    return NextResponse.json({ ok: true })
  }
  if (body.action === 'toggle' && typeof body.enabled === 'boolean') {
    // a toggle to the state the channel is already in changes nothing, so it records nothing
    const was = (await db.get<{ enabled: number }>('SELECT enabled FROM tenant_connectors WHERE tenant_id = ? AND connector = ?', [user.tenantId, connectorId(p)]))?.enabled === 1
    const ok = await setEnabled(db, user.tenantId, connectorId(p), body.enabled)
    if (ok && was !== body.enabled) await audit(user, req, { action: body.enabled ? 'connector.enabled' : 'connector.disabled', resource: 'social', id: p, summary: { platform: p } })
    return NextResponse.json({ ok })
  }
  if (body.action === 'save') {
    const rl = (await rateLimit(`adv:${user.tenantId}`, 10, 60 * 60 * 1000))
    if (!rl.ok) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
    if (!(await readConsent(db, user.tenantId, scopeFor(p)))) return NextResponse.json({ error: 'Accept the risk notice first' }, { status: 403 })
    const session = typeof body.session === 'string' ? body.session.trim() : ''
    if (session.length < 10 || session.length > 8000) return NextResponse.json({ error: 'That does not look like a valid session' }, { status: 400 })
    if (!process.env.DAZL_MASTER_KEY) return NextResponse.json({ error: 'Key storage is not available right now' }, { status: 503 })
    await writeCredential(db, user.tenantId, connectorId(p), session)
    await audit(user, req, { action: 'credential.saved', resource: 'social', id: p, summary: { platform: p } })
    return NextResponse.json({ ok: true, last4: session.slice(-4) })
  }
  return NextResponse.json({ error: 'Bad request' }, { status: 400 })
}

export async function DELETE(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'configure'); if (no) return no
  const old = stale(user); if (old) return old

  const p = req.nextUrl.searchParams.get('platform')
  if (!isAdvPlatform(p)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const ok = await removeCredential(await getDb(), user.tenantId, connectorId(p))
  if (ok) await audit(user, req, { action: 'credential.removed', resource: 'social', id: p, summary: { platform: p } })
  return NextResponse.json({ ok })
}
