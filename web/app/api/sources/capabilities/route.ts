import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { tenantCapabilities } from '@/lib/sources/capability-report'

// The source-capability matrix for the session's workspace: markets, refresh, identity/date proof, license/access policy and failure reporting per
// source, with availability for this tenant. A disconnected worker is "unavailable" and an unbuilt platform is "not_built"; neither is "no opportunities".
// X without a session follows xViaOperatorIndex (lib/advanced), the same rule the scan uses.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  return NextResponse.json({ capabilities: await tenantCapabilities(await getDb(), user.tenantId) })
}
