import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { auditPush, claimPush, CrmPushError, crmDestination, disconnectCrm, finishClaim, getCrmConfig, pushLead, resolveClaim, saveCrmConfig } from '@/lib/crm/index'
import { defaultLookup, resolvePublic } from '@/lib/net/public-fetch'
import { sameOriginJson } from '@/lib/same-origin'
import { captureError } from '@/lib/ops/errors'
import { requestIdOf } from '@/lib/ops/request-log'
import { rateLimit } from '@/lib/rate-limit'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  const cfg = getCrmConfig(db, user.id)
  // Status only. The key/URL is never returned.
  return NextResponse.json({ configured: !!cfg, provider: cfg?.provider ?? null })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!(await rateLimit(`crm:${user.id}`, 20, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const body = await req.json().catch(() => null)
  const db = getScanDb()
  switch (body?.action) {
    case 'save': {
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
      saveCrmConfig(db, user.id, provider === 'webhook' ? { provider, url } : { provider, key })
      return NextResponse.json({ ok: true })
    }
    case 'disconnect':
      disconnectCrm(db, user.id)
      return NextResponse.json({ ok: true })
    case 'push':
    case 'resolve': {
      const cfg = getCrmConfig(db, user.id)
      if (!cfg) return NextResponse.json({ error: 'Connect a CRM in Settings first' }, { status: 400 })
      const leadId = typeof body?.lead_id === 'string' ? body.lead_id : ''
      const lead = db.prepare('SELECT l.id, l.scan_job_id, l.company, l.name, l.contact, l.signal, l.source_url, l.fit, l.intent, l.why FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?').get(leadId, user.id) as { id: string; scan_job_id: string; company: string; name: string; contact: string | null; signal: string; source_url: string; fit: number | null; intent: number | null; why: string | null } | undefined
      if (!lead) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      // the generic webhook keeps its own protocol: no record id, no claim
      const dest = cfg.provider === 'webhook' ? null : crmDestination(cfg)
      if (body.action === 'resolve') {
        // The user checked the CRM after an unknown result and says whether the record is there. Only then may the
        // lead be pushed again (when it is not there).
        if (typeof body?.created !== 'boolean') return NextResponse.json({ error: 'Say whether the contact is in your CRM' }, { status: 400 })
        if (!dest || !resolveClaim(db, user.id, dest, lead.id, body.created)) return NextResponse.json({ error: 'Nothing to resolve for this lead' }, { status: 409 })
        auditPush(db, user.id, cfg.provider, lead, body.created ? 'resolved_created' : 'resolved_not_created')
        return NextResponse.json({ ok: true })
      }
      let attemptId = ''
      if (dest) {
        const c = claimPush(db, user.id, dest, lead.id)
        if ('blocked' in c) return NextResponse.json(c.blocked === 'in_progress'
          ? { error: 'This lead is being pushed right now. Wait a moment, then check your CRM.', outcome: 'in_progress' }
          : { error: 'An earlier push of this lead has an unknown result. Check your CRM for this contact first, then record what you found.', outcome: 'unknown' }, { status: 409 })
        attemptId = c.attemptId
      }
      // A result that cannot be recorded leaves the claim pending (it turns unknown), so a retry is never made safe by
      // a failed write: the response says unknown too.
      const finish = (status: 'ok' | 'failed' | 'uncertain', id: string | null) => {
        if (!dest) return true
        try { return finishClaim(db, user.id, dest, lead.id, attemptId, status, id) } catch (e) { captureError(e, { source: 'route', where: '/api/crm', method: 'POST', tenantId: user.id, requestId: requestIdOf(req) }); return false }
      }
      const unknownReply = () => NextResponse.json({ error: 'The result of this push could not be recorded. Check your CRM for this contact first, then record what you found.', outcome: 'unknown' }, { status: 502 })
      let r: Awaited<ReturnType<typeof pushLead>>
      try {
        r = await pushLead(cfg, lead)
      } catch (e) {
        const unknown = e instanceof CrmPushError && e.outcome === 'unknown'
        if (!finish(unknown ? 'uncertain' : 'failed', null)) return unknownReply()
        auditPush(db, user.id, cfg.provider, lead, unknown ? 'uncertain' : 'worker_error')
        captureError(e, { source: 'route', where: '/api/crm', method: 'POST', tenantId: user.id, requestId: requestIdOf(req) })
        return NextResponse.json({ error: e instanceof Error ? e.message : 'Push failed', outcome: unknown ? 'unknown' : 'failed' }, { status: 502 })
      }
      if (!finish('ok', r.externalId)) return unknownReply()
      auditPush(db, user.id, cfg.provider, lead, 'ok')
      return NextResponse.json({ ok: true, message: r.message, external_id: r.externalId })
    }
    default:
      return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  }
}
