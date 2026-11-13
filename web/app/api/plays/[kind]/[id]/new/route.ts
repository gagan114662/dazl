import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { playNew } from '@/lib/play-now'

// #1042: what one saved play found since `since` (unix seconds, default 0 = ever): the same "new" each run counts on the
// Plays page (lib/play-now.ts playNew). Read-only. Another account's play, an unknown kind or a bad `since` is refused.
export async function GET(req: Request, ctx: { params: Promise<{ kind: string; id: string }> }) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const { kind, id } = await ctx.params
  if ((kind !== 'watch' && kind !== 'monitor') || !/^[0-9a-f]{24}$/.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const raw = new URL(req.url).searchParams.get('since') ?? '0'
  if (!/^\d{1,12}$/.test(raw)) return NextResponse.json({ error: 'Bad since' }, { status: 400 })
  const r = await playNew(await getDb(), user.tenantId, kind, id, Number(raw))
  if (!r) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(r)
}
