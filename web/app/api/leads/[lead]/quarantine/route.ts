import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { setQuarantine } from '@/lib/scan/quarantine'
import { audit } from '@/lib/audit-route'
import { denied } from '@/lib/workspace-access'
import type { Action } from '@/lib/workspaces'

// Quarantine a lead (wrong company, wrong contact details): kept with all its evidence, but never drafted, sent,
// picked by autopilot or exported. DELETE releases it. Reversible; nothing is deleted.

async function guard(req: NextRequest, leadId: string, action: Action) {
  const user = await requireUser()
  if (!user) return { res: NextResponse.json({ error: 'Not signed in' }, { status: 401 }) }
  const no = denied(user, action)
  if (no) return { res: no }
  if (!sameOriginJson(req)) return { res: NextResponse.json({ error: 'Bad origin' }, { status: 403 }) }
  if (!/^[a-f0-9]{24}$/.test(leadId)) return { res: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  if (!(await rateLimit(`quarantine-lead:${user.tenantId}`, 60, 60_000)).ok) return { res: NextResponse.json({ error: 'Too many requests' }, { status: 429 }) }
  return { user }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ lead: string }> }) {
  const { lead } = await params
  const g = await guard(req, lead, 'operate')
  if (g.res) return g.res
  const body = await req.json().catch(() => ({})) as { reason?: unknown }
  const r = await setQuarantine(await getDb(), g.user!.tenantId, lead, 'quarantine', typeof body.reason === 'string' ? body.reason : '')
  if (r.status === 'not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // the typed reason is the user's own text: the trail records only that one was given
  await audit(g.user!, req, { action: 'pipeline.quarantined', resource: 'lead', id: lead, summary: { with_reason: typeof body.reason === 'string' && body.reason.trim() !== '' } })
  return NextResponse.json({ quarantined: true })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ lead: string }> }) {
  const { lead } = await params
  const g = await guard(req, lead, 'operate')
  if (g.res) return g.res
  const r = await setQuarantine(await getDb(), g.user!.tenantId, lead, 'release')
  if (r.status === 'not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // releasing a lead that is not quarantined changes nothing, so it records nothing
  if (r.status === 'released') await audit(g.user!, req, { action: 'pipeline.released', resource: 'lead', id: lead })
  return NextResponse.json({ quarantined: false })
}
