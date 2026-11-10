import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { connectorStatus } from '@/lib/connectors/store'
import { readConsent } from '@/lib/advanced'
import { advFlags, ADV_PLATFORMS, scopeFor, platformAllowed, type AdvPlatform } from '@/lib/advanced/config'
import { tinyfishEnabled } from '@/lib/search/tinyfish'
import { capabilityReport } from '@/lib/sources/capability-report'

// The source-capability matrix for the session's workspace: markets, refresh, identity/date proof, license/access policy and failure reporting per
// source, with availability for this tenant. A disconnected worker is "unavailable" and an unbuilt platform is "not_built"; neither is "no opportunities".
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = await getDb()
  const flags = advFlags()
  const consented = new Set<AdvPlatform>()
  for (const p of ADV_PLATFORMS) if (await readConsent(db, user.tenantId, scopeFor(p))) consented.add(p)
  const rows = capabilityReport({ connectors: await connectorStatus(db, user.tenantId), consented, flags, xViaOperatorIndex: tinyfishEnabled() && platformAllowed('x', flags) })
  return NextResponse.json({ capabilities: rows })
}
