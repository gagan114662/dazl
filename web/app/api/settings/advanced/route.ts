import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { saveCredential, deleteCredential, connectorStatus, setEnabled } from '@/lib/connectors/store'
import { acceptConsent, hasConsent, revokeConsent } from '@/lib/advanced'
import { advFlags, UI_PLATFORMS, connectorId, CONSENT_VERSION, isAdvPlatform, platformAllowed, scopeFor } from '@/lib/advanced/config'
import { tinyfishEnabled } from '@/lib/search/tinyfish'
import { rateLimit } from '@/lib/rate-limit'
import { sameOriginJson } from '@/lib/same-origin'

// Status never includes a credential. When the operator has not enabled the tier, it reports available: false.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  const f = advFlags()
  const st = connectorStatus(db, user.id)
  return NextResponse.json({
    available: f.enabled, version: CONSENT_VERSION,
    // The three platforms the UI offers. allowed = the operator has switched it on for this server.
    platforms: UI_PLATFORMS.map(p => {
      const c = st.find(x => x.connector === connectorId(p))
      // X needs no session when the operator key is set (TinyFish public-index path): expose that as
      // operator_index so the UI can offer the checkbox on consent alone, matching collectAdvanced.
      const operatorIndex = p === 'x' && tinyfishEnabled() && platformAllowed(p, f)
      return { platform: p, allowed: platformAllowed(p, f), consent: hasConsent(db, user.id, scopeFor(p)), connected: !!c, enabled: !!c?.enabled, operator_index: operatorIndex, last4: c?.last4 ?? null, high_risk: p === 'linkedin' }
    }),
  })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  const f = advFlags()
  if (!isAdvPlatform(body?.platform) || !platformAllowed(body.platform, f)) return NextResponse.json({ error: 'Not available' }, { status: 404 })
  const db = getScanDb()
  const p = body.platform
  if (body.action === 'consent') {
    if (body.accept !== true || body.version !== CONSENT_VERSION) return NextResponse.json({ error: 'Consent not recorded' }, { status: 400 })
    acceptConsent(db, user.id, scopeFor(p))
    return NextResponse.json({ ok: true })
  }
  if (body.action === 'revoke') { revokeConsent(db, user.id, scopeFor(p)); setEnabled(db, user.id, connectorId(p), false); return NextResponse.json({ ok: true }) }
  if (body.action === 'toggle' && typeof body.enabled === 'boolean') return NextResponse.json({ ok: setEnabled(db, user.id, connectorId(p), body.enabled) })
  if (body.action === 'save') {
    const rl = rateLimit(`adv:${user.id}`, 10, 60 * 60 * 1000)
    if (!rl.ok) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
    if (!hasConsent(db, user.id, scopeFor(p))) return NextResponse.json({ error: 'Accept the risk notice first' }, { status: 403 })
    const session = typeof body.session === 'string' ? body.session.trim() : ''
    if (session.length < 10 || session.length > 8000) return NextResponse.json({ error: 'That does not look like a valid session' }, { status: 400 })
    if (!process.env.DAZL_MASTER_KEY) return NextResponse.json({ error: 'Key storage is not available right now' }, { status: 503 })
    saveCredential(db, user.id, connectorId(p), session)
    return NextResponse.json({ ok: true, last4: session.slice(-4) })
  }
  return NextResponse.json({ error: 'Bad request' }, { status: 400 })
}

export async function DELETE(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const p = req.nextUrl.searchParams.get('platform')
  if (!isAdvPlatform(p)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  return NextResponse.json({ ok: deleteCredential(getScanDb(), user.id, connectorId(p)) })
}
