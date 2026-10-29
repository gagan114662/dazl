import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { auditPush, disconnectCrm, getCrmConfig, pushLead, saveCrmConfig } from '@/lib/crm/index'
import { defaultLookup, resolvePublic } from '@/lib/net/public-fetch'
import { sameOriginJson } from '@/lib/same-origin'
import { captureError } from '@/lib/ops/errors'
import { requestIdOf } from '@/lib/ops/request-log'
import { rateLimit } from '@/lib/rate-limit'
import { denied } from '@/lib/workspace-access'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  const cfg = getCrmConfig(db, user.tenantId)
  // Status only. The key/URL is never returned.
  return NextResponse.json({ configured: !!cfg, provider: cfg?.provider ?? null })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'operate'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!(await rateLimit(`crm:${user.tenantId}`, 20, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const body = await req.json().catch(() => null)
  const db = getScanDb()
  switch (body?.action) {
    case 'save': {
      const cannot = denied(user, 'configure'); if (cannot) return cannot
      const provider = body?.provider
      if (!['hubspot', 'pipedrive', 'webhook'].includes(provider)) return NextResponse.json({ error: 'Pick HubSpot, Pipedrive or webhook' }, { status: 400 })
      const key = typeof body?.key === 'string' ? body.key.trim() : ''
      const url = typeof body?.url === 'string' ? body.url.trim() : ''
      if (provider === 'webhook' && !/^https:\/\/\S{4,400}$/.test(url)) return NextResponse.json({ error: 'Webhook URL must be https' }, { status: 400 })
      if (provider === 'webhook') {
        let host = ''
        try { host = new URL(url).hostname } catch { return NextResponse.json({ error: 'Webhook URL must be https' }, { status: 400 }) }
        // Save-time check; the push path re-validates at send time since DNS can be re-pointed later.
        if (!(await resolvePublic(host, defaultLookup))) return NextResponse.json({ error: 'Webhook URL must point at a public address' }, { status: 400 })
      }
      if (provider !== 'webhook' && key.length < 8) return NextResponse.json({ error: 'That key looks too short' }, { status: 400 })
      if (!process.env.DAZL_MASTER_KEY) return NextResponse.json({ error: 'Key storage is not available right now' }, { status: 503 })
      saveCrmConfig(db, user.tenantId, provider === 'webhook' ? { provider, url } : { provider, key })
      return NextResponse.json({ ok: true })
    }
    case 'disconnect': {
      const cannot = denied(user, 'configure'); if (cannot) return cannot
      disconnectCrm(db, user.tenantId)
      return NextResponse.json({ ok: true })
    }
    case 'push': {
      const cfg = getCrmConfig(db, user.tenantId)
      if (!cfg) return NextResponse.json({ error: 'Connect a CRM in Settings first' }, { status: 400 })
      const leadId = typeof body?.lead_id === 'string' ? body.lead_id : ''
      const lead = db.prepare('SELECT l.company, l.name, l.contact, l.signal, l.source_url, l.fit, l.intent, l.why FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?').get(leadId, user.tenantId) as { company: string; name: string; contact: string | null; signal: string; source_url: string; fit: number | null; intent: number | null; why: string | null } | undefined
      if (!lead) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      try {
        const msg = await pushLead(cfg, lead)
        auditPush(db, user.tenantId, cfg.provider, lead.company, true)
        return NextResponse.json({ ok: true, message: msg })
      } catch (e) {
        auditPush(db, user.tenantId, cfg.provider, lead.company, false)
        captureError(e, { source: 'route', where: '/api/crm', method: 'POST', tenantId: user.tenantId, requestId: requestIdOf(req) })
        return NextResponse.json({ error: e instanceof Error ? e.message : 'Push failed' }, { status: 502 })
      }
    }
    default:
      return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  }
}
