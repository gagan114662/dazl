// The dazl Connect browser extension's one endpoint (#1037, F-go step 2; lib/advanced/linkedin-connect.ts). No session cookie: the caller
// is authenticated by the bearer secret it holds (a one-time pairing code, then its device token). There are no CORS headers, so a web
// page on another site cannot call it (a bearer header forces a preflight nobody answers); the extension's own host permission lets it
// call. Actions:
//   pair     Bearer <pairing code>  -> { device_token }                       (the code is spent)
//   session  Bearer <device token>  { li_at, jsessionid } -> { ok, name }     (saved as the tenant's LinkedIn session; the account is
//                                                                              named once, or again when asked with check: true)
//   status   Bearer <device token>  -> { connected: true, name }
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db/client'
import { advFlags, platformAllowed } from '@/lib/advanced/config'
import { readConsent } from '@/lib/advanced'
import { authDevice, guardedAccountCheck, recordAccount, redeemPairing, saveSessionFromDevice, sessionFromCookies } from '@/lib/advanced/linkedin-connect'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { audit } from '@/lib/audit-route'

const bearer = (req: NextRequest) => /^Bearer ([A-Za-z0-9._-]{10,200})$/.exec(req.headers.get('authorization') ?? '')?.[1] ?? null
const no = (status: number, error: string) => NextResponse.json({ error }, { status })

export async function POST(req: NextRequest) {
  if (!platformAllowed('linkedin', advFlags())) return no(404, 'Not available')
  const ip = await rateLimit(`ext-li-ip:${clientIp(req)}`, 30, 10 * 60 * 1000)
  if (!ip.ok) return no(429, 'Too many attempts. Try again later.')
  const secret = bearer(req)
  if (!secret) return no(401, 'unauthorized')
  const body = await req.json().catch(() => null) as { action?: unknown; li_at?: unknown; jsessionid?: unknown; check?: unknown } | null
  if (!body || typeof body !== 'object' || Array.isArray(body)) return no(400, 'Bad request')
  const db = await getDb()

  if (body.action === 'pair') {
    const r = await redeemPairing(db, secret)
    if (!r) return no(401, 'This code is not valid any more. Start again from dazl Settings.')
    await audit({ tenantId: r.tenantId, actorId: r.userId }, req, { action: 'credential.device_paired', resource: 'social', id: 'linkedin', summary: { platform: 'linkedin' } })
    return NextResponse.json({ device_token: r.token })
  }

  const dev = await authDevice(db, secret)
  if (!dev) return no(401, 'unauthorized')
  if (body.action === 'status') return NextResponse.json({ connected: true, name: dev.device.name })
  if (body.action !== 'session') return no(400, 'Bad request')
  const rl = await rateLimit(`ext-li:${dev.tenantId}`, 30, 60 * 60 * 1000)
  if (!rl.ok) return no(429, 'Too many attempts. Try again later.')
  // The risk notice is checked on every save: a workspace that withdrew it stores nothing new.
  if (!(await readConsent(db, dev.tenantId, 'linkedin'))) return no(403, 'Accept the LinkedIn risk notice in dazl Settings first')
  if (!process.env.DAZL_MASTER_KEY) return no(503, 'Key storage is not available right now')
  const session = sessionFromCookies(body.li_at, body.jsessionid)
  if (!session) return no(400, 'That does not look like a signed-in LinkedIn session')
  const now = Math.floor(Date.now() / 1000)
  // In one transaction with the device check: a Disconnect (or a newer pairing) since the check means nothing is written (401).
  const saved = await saveSessionFromDevice(db, dev.tenantId, dev.device, dev.ciphertext, session, now)
  if (!saved) return no(401, 'unauthorized')
  await audit({ tenantId: dev.tenantId, actorId: dev.device.u }, req, { action: 'credential.saved', resource: 'social', id: 'linkedin', summary: { platform: 'linkedin', via: 'extension' } })
  // Name the account once (and when the user asks): ONE read of the session's own profile, behind every LinkedIn guard (connector on, no
  // cooldown, the shared hourly budget) and at most 6 per workspace per hour.
  let name = dev.device.name, outcome: string | null = null
  if (name === null || body.check === true) {
    const me = (await rateLimit(`adv-me:${dev.tenantId}`, 6, 60 * 60 * 1000)).ok ? await guardedAccountCheck(db, dev.tenantId) : { ok: false as const, outcome: 'rate_limited' }
    if (me.ok) {
      if (!(await recordAccount(db, dev.tenantId, { ...dev.device, synced_at: now }, saved, me))) return no(401, 'unauthorized')
      name = me.name
    } else outcome = me.outcome
  }
  return NextResponse.json({ ok: true, name, check: outcome })
}
