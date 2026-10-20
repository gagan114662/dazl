import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { connectorStatus, deleteCredential, recentAudit, saveCredential, setEnabled } from '@/lib/connectors/store'
import { validateHunterKey } from '@/lib/connectors/hunter'
import { rateLimit } from '@/lib/rate-limit'
import { sameOriginJson } from '@/lib/same-origin'

const CONNECTORS = ['hunter'] as const
const isConnector = (v: unknown): v is (typeof CONNECTORS)[number] => typeof v === 'string' && (CONNECTORS as readonly string[]).includes(v)

// Status and audit only. Credentials are never returned.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  return NextResponse.json({ connectors: connectorStatus(db, user.id), audit: recentAudit(db, user.id) })
}

export async function PUT(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const rl = rateLimit(`connector:${user.id}`, 10, 60 * 60 * 1000)
  if (!rl.ok) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterS) } })
  const body = await req.json().catch(() => null)
  const secret = typeof body?.api_key === 'string' ? body.api_key.trim() : ''
  if (!isConnector(body?.connector) || secret.length < 20 || secret.length > 200 || /\s/.test(secret)) return NextResponse.json({ error: 'That does not look like a valid key' }, { status: 400 })
  if (!process.env.DAZL_MASTER_KEY) return NextResponse.json({ error: 'Key storage is not available right now' }, { status: 503 })
  const check = await validateHunterKey(secret)
  if (check === 'invalid') return NextResponse.json({ error: 'Hunter rejected this key' }, { status: 400 })
  if (check === 'unavailable') return NextResponse.json({ error: 'Could not reach Hunter to check the key. Try again.' }, { status: 502 })
  saveCredential(getScanDb(), user.id, body.connector, secret)
  return NextResponse.json({ ok: true, connector: body.connector, last4: secret.slice(-4) })
}

export async function PATCH(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  if (!isConnector(body?.connector) || typeof body?.enabled !== 'boolean') return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  return NextResponse.json({ ok: setEnabled(getScanDb(), user.id, body.connector, body.enabled) })
}

export async function DELETE(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const c = req.nextUrl.searchParams.get('connector')
  if (!isConnector(c)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  return NextResponse.json({ ok: deleteCredential(getScanDb(), user.id, c) })
}
