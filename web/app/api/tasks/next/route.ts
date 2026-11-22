// GET /api/tasks/next (#1122): the next LinkedIn page this workspace's extension may read, or how long to wait. Every pacing rule
// (working hours, one at a time, 45-180 s pause, 40 a day, cooldown, pause) is decided by the server in lib/linkedin-tasks/store.ts.
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db/client'
import { nextTask } from '@/lib/linkedin-tasks/store'
import { extTenant } from '@/app/api/tasks/_auth'

export async function GET(req: NextRequest) {
  const a = await extTenant(req)
  if ('error' in a) return NextResponse.json({ error: a.error }, { status: a.status })
  return NextResponse.json(await nextTask(await getDb(), a.tenantId), { headers: { 'cache-control': 'no-store' } })
}
