import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { CONFIRM_PHRASE, deletionStatus } from '@/lib/tenant/requests'

// The signed-in account's data requests (issue #359): its deletion request, if any, and how many exports it took.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const s = await deletionStatus(await getDb(), user.id)
  const view = (r: typeof s.last) => r && { id: r.id, status: r.status, requested_at: Number(r.requested_at), decided_at: r.decided_at === null ? null : Number(r.decided_at), note: r.note }
  return NextResponse.json({ pending: view(s.pending), last: view(s.last), exports: s.exports, confirm_phrase: CONFIRM_PHRASE })
}
