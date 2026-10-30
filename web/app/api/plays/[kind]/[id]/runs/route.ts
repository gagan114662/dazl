import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { playRuns } from '@/lib/play-runs'

// #351: one saved play's runs, newest first (lib/play-runs.ts). Another account's play, or an unknown kind, is 404.
export async function GET(_req: Request, ctx: { params: Promise<{ kind: string; id: string }> }) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const { kind, id } = await ctx.params
  if ((kind !== 'watch' && kind !== 'monitor') || !/^[0-9a-f]{24}$/.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const runs = await playRuns(await getDb(), user.tenantId, kind, id)
  if (!runs) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ runs })
}
