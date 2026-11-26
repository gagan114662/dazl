import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { removeKey, readKeyStatus } from '@/lib/llm/key-store'
import { openKeyRejection } from '@/lib/llm/key-evidence'
import { isVendor } from '@/lib/llm/vendors'
import { sameOriginJson } from '@/lib/same-origin'
import { audit } from '@/lib/audit-route'
import { denied, stale } from '@/lib/workspace-access'

// Status only: vendor, last 4 characters and when it was validated. The key itself is never returned. rejection: a later
// scan that stopped on this account's key with no acceptance of that same key since (lib/llm/key-evidence.ts); read-only.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = await getDb()
  return NextResponse.json({ keys: await readKeyStatus(db, user.tenantId), rejection: await openKeyRejection(db, user.tenantId) })
}

export async function PUT(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'configure'); if (no) return no
  const old = stale(user); if (old) return old

  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  return NextResponse.json({ error: 'Saving AI keys is no longer supported.' }, { status: 410 })
}

export async function DELETE(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'configure'); if (no) return no
  const old = stale(user); if (old) return old

  const vendor = req.nextUrl.searchParams.get('vendor')
  if (!isVendor(vendor)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const ok = await removeKey(await getDb(), user.tenantId, vendor)
  if (ok) await audit(user, req, { action: 'credential.removed', resource: 'llm_key', id: vendor, summary: { vendor } })
  return NextResponse.json({ ok })
}
