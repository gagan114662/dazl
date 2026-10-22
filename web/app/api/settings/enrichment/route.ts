// BYOK enrichment keys (Apollo / People Data Labs). Status never returns a key.
import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { audit, connectorStatus, deleteCredential, recentAudit, saveCredential } from '@/lib/connectors/store'
import { sameOriginJson } from '@/lib/same-origin'
import { enrichmentWriteLimit } from '@/lib/settings/enrichment-guard'

const CONNECTORS = ['enrich:apollo', 'enrich:pdl']

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  const status = connectorStatus(db, user.id).filter(s => CONNECTORS.includes(s.connector))
  const auditRows = (recentAudit(db, user.id, 50) as { connector: string }[]).filter(r => CONNECTORS.includes(r.connector)).slice(0, 20)
  return NextResponse.json({ connectors: status, audit: auditRows })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad origin' }, { status: 403 })
  const limited = enrichmentWriteLimit(user.id)
  if (!limited.ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: { 'Retry-After': String(limited.retryAfterS) } })
  if (!process.env.DAZL_MASTER_KEY) return NextResponse.json({ error: 'Credential storage unavailable' }, { status: 503 })
  const body = (await req.json().catch(() => null)) as { connector?: string; key?: string; disconnect?: boolean } | null
  if (!body || !body.connector || !CONNECTORS.includes(body.connector)) return NextResponse.json({ error: 'Unknown connector' }, { status: 400 })
  const db = getScanDb()
  if (body.disconnect) {
    deleteCredential(db, user.id, body.connector)
    return NextResponse.json({ ok: true, disconnected: true })
  }
  const key = (body.key ?? '').trim()
  if (key.length < 16 || key.length > 200) return NextResponse.json({ error: 'That does not look like an API key' }, { status: 400 })
  saveCredential(db, user.id, body.connector, key)
  audit(db, { tenantId: user.id, connector: body.connector, lookup: 'key saved', status: 'ok', results: 0 })
  return NextResponse.json({ ok: true })
}
