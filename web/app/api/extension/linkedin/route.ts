// The dazl Connect browser extension's one endpoint (#1037, F-go step 2; lib/advanced/linkedin-connect.ts). No session cookie: the caller
// is authenticated by the bearer secret it holds (a one-time pairing code, then its device token). There are no CORS headers, so a web
// page on another site cannot call it (a bearer header forces a preflight nobody answers); the extension's own host permission lets it
// call. Actions:
//   pair     Bearer <pairing code>  -> { device_token }                       (the code is spent)
//   session  removed (#1122): dazl stores no LinkedIn session; 410 tells an old build to update. Reading is /api/tasks/*.
//   status   Bearer <device token>  -> { connected: true, name }
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db/client'
import { linkedinConnectAllowed } from '@/lib/advanced/config'
import { authDevice, redeemPairing } from '@/lib/advanced/linkedin-connect'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { audit } from '@/lib/audit-route'

const bearer = (req: NextRequest) => /^Bearer ([A-Za-z0-9._-]{10,200})$/.exec(req.headers.get('authorization') ?? '')?.[1] ?? null
const no = (status: number, error: string) => NextResponse.json({ error }, { status })

export async function POST(req: NextRequest) {
  if (!linkedinConnectAllowed()) return no(404, 'Not available')
  const ip = await rateLimit(`ext-li-ip:${clientIp(req)}`, 30, 10 * 60 * 1000)
  if (!ip.ok) return no(429, 'Too many attempts. Try again later.')
  const secret = bearer(req)
  if (!secret) return no(401, 'unauthorized')
  const body = await req.json().catch(() => null) as { action?: unknown } | null
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
  // #1122: the extension no longer sends a LinkedIn session and dazl stores none; an old build that still tries is told so.
  if (body.action === 'session') return no(410, 'Update dazl Connect: LinkedIn is now read in your browser and dazl stores no LinkedIn session.')
  return no(400, 'Bad request')
}
