import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { listWorkspaces } from '@/lib/workspace-members'

// The workspace this session acts in, and every workspace the account belongs to (for the switcher).
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const workspaces = await listWorkspaces(await getDb(), user.actorId)
  return NextResponse.json({ current: { tenant_id: user.tenantId, role: user.role }, you: { id: user.actorId, email: user.email }, workspaces })
}
