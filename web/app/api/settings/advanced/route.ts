import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { writeCredential, removeCredential, connectorStatus, setEnabled } from '@/lib/connectors/store'
import { writeConsent, readConsent, removeConsent } from '@/lib/advanced'
import { advFlags, UI_PLATFORMS, connectorId, CONSENT_VERSION, isAdvPlatform, isSupported, platformAllowed, scopeFor, UNSUPPORTED } from '@/lib/advanced/config'
import { tinyfishEnabled } from '@/lib/search/tinyfish'
import { rateLimit } from '@/lib/rate-limit'
import { sameOriginJson } from '@/lib/same-origin'

// Status never includes a credential. When the operator has not enabled the tier, it reports available: false.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = await getDb()
  const f = advFlags()
  const st = await connectorStatus(db, user.id)
  return NextResponse.json({
    available: f.enabled, version: CONSENT_VERSION,
    // The three platforms the UI offers. allowed = the operator has switched it on for this server.
    platforms: await Promise.all(UI_PLATFORMS.map(async p => {
      const c = st.find(x => x.connector === connectorId(p))
      // X needs no session when the operator key is set (TinyFish public-index path): expose that as
      // operator_index so the UI can offer the checkbox on consent alone, matching collectAdvanced.
      const operatorIndex = p === 'x' && tinyfishEnabled() && platformAllowed(p, f)
      // supported: false = no fetcher exists (UNSUPPORTED). The UI then offers no consent and no session, only removal
      // of one stored earlier; enabled is reported false whatever is stored, since nothing would use it.
      const supported = isSupported(p)
      return { platform: p, allowed: platformAllowed(p, f), supported, unsupported_reason: UNSUPPORTED[p] ?? null, consent: await readConsent(db, user.id, scopeFor(p)), connected: !!c, enabled: supported && !!c?.enabled, operator_index: operatorIndex, last4: c?.last4 ?? null, high_risk: p === 'linkedin' }
    })),
  })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  const f = advFlags()
  if (!isAdvPlatform(body?.platform) || !platformAllowed(body.platform, f)) return NextResponse.json({ error: 'Not available' }, { status: 404 })
  const db = await getDb()
  const p = body.platform
  // no consent, session or switch for a platform dazl cannot fetch: nothing would ever use it (#436)
  if (!isSupported(p)) return NextResponse.json({ error: 'Not available: this platform is not built yet', unsupported: true }, { status: 409 })
  if (body.action === 'consent') {
    if (body.accept !== true || body.version !== CONSENT_VERSION) return NextResponse.json({ error: 'Consent not recorded' }, { status: 400 })
    await writeConsent(db, user.id, scopeFor(p))
    return NextResponse.json({ ok: true })
  }
  if (body.action === 'revoke') { await removeConsent(db, user.id, scopeFor(p)); await setEnabled(db, user.id, connectorId(p), false); return NextResponse.json({ ok: true }) }
  if (body.action === 'toggle' && typeof body.enabled === 'boolean') return NextResponse.json({ ok: await setEnabled(db, user.id, connectorId(p), body.enabled) })
  if (body.action === 'save') {
    const rl = (await rateLimit(`adv:${user.id}`, 10, 60 * 60 * 1000))
    if (!rl.ok) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
    if (!(await readConsent(db, user.id, scopeFor(p)))) return NextResponse.json({ error: 'Accept the risk notice first' }, { status: 403 })
    const session = typeof body.session === 'string' ? body.session.trim() : ''
    if (session.length < 10 || session.length > 8000) return NextResponse.json({ error: 'That does not look like a valid session' }, { status: 400 })
    if (!process.env.DAZL_MASTER_KEY) return NextResponse.json({ error: 'Key storage is not available right now' }, { status: 503 })
    await writeCredential(db, user.id, connectorId(p), session)
    return NextResponse.json({ ok: true, last4: session.slice(-4) })
  }
  return NextResponse.json({ error: 'Bad request' }, { status: 400 })
}

export async function DELETE(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const p = req.nextUrl.searchParams.get('platform')
  if (!isAdvPlatform(p)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  return NextResponse.json({ ok: await removeCredential(await getDb(), user.id, connectorId(p)) })
}
