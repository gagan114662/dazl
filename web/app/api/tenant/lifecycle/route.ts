import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { tenantTableCounts, tombstone, ALWAYS_RETAINED, type Tombstone } from '@/lib/tenant/lifecycle'
import { can } from '@/lib/workspaces'

// What the account's export/deletion covers, and where a deletion stands. Session-scoped: the tenant comes only
// from the session. Scope inventory = row counts per tenant-owned table; retention exceptions = the ALWAYS_RETAINED
// append-only tables plus, once a deletion is recorded, its policy and retained counts. can_delete lets the
// settings panel offer deletion only to roles the delete route would allow (owners); the route still enforces.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = await getDb()
  const t: Tombstone | null = (await tombstone(db, user.tenantId)) ?? null
  return NextResponse.json({
    tenant: user.tenantId,
    tables: await tenantTableCounts(db, user.tenantId),
    always_retained: Object.keys(ALWAYS_RETAINED),
    can_delete: can(user.role, 'owners'),
    deletion: t ? { state: t.state, requested_at: t.requested_at, requested_by: t.requested_by, policy: JSON.parse(t.policy), retained: t.retained ? JSON.parse(t.retained) : null, completed_at: t.completed_at } : null,
  })
}
