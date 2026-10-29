import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { leave } from '@/lib/workspace-members'
import { memberFail } from '@/lib/workspace-access'
import { requestIdOf } from '@/lib/ops/request-log'

// Leave the workspace this session acts in. The last owner cannot leave; the next request uses another workspace.
export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  try {
    await leave(await getDb(), { ...user, correlationId: requestIdOf(req) })
    return NextResponse.json({ ok: true })
  } catch (e) { return memberFail(e) }
}
