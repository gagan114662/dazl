import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { getDb } from '@/lib/db/client'
import { tinyfishToday } from '@/lib/search/tinyfish'

// #1082 ops status: today's TinyFish use per kind and per active tenant (units, largest first; never a tenant id).
// Operator only: the same shared secret as /api/internal/tick. Without it configured the route does not exist; the
// public /api/health/scheduler shows the platform totals only.
export async function GET(req: NextRequest) {
  const secret = process.env.AUTOPILOT_TICK_SECRET
  const got = req.headers.get('authorization') ?? ''
  const want = `Bearer ${secret}`
  if (!secret || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(await tinyfishToday(await getDb(), Math.floor(Date.now() / 1000)), { headers: { 'Cache-Control': 'no-store' } })
}
