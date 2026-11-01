import { NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { denied } from '@/lib/workspace-access'
import { heldEnrichments, heldCostText } from '@/lib/enrich/index'

// Enrichment lookups a rate limit or crash left HELD (never automatically retried, so a possibly-charged call is
// never silently re-billed). Each row carries the exact cost/limits wording the owner acts on before retrying.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'operate'); if (no) return no
  const held = heldEnrichments(getScanDb(), user.tenantId).map(h => ({
    leadId: h.leadId, company: h.company, provider: h.provider, step: h.step, since: h.claimedAt, costText: heldCostText(h),
  }))
  return NextResponse.json({ held })
}
