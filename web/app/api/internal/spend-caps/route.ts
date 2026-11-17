import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { spendCapsCheck, TENANT_ID } from '@/lib/ops/spend-caps-check'

// #846/#847 operator check: the four spend caps of this deployment (per scan, per account, per day, per month), each with
// its effective number, where it came from, and the real reservation code's outcome at it, simulated in a throwaway
// in-memory store (lib/ops/spend-caps-check.ts): no model call, nothing spent, the app's store never opened.
// Operator only: the same shared secret as /api/internal/tick. Without it configured, or with a wrong one, the route
// does not exist (404). Optional ?tenant=<account id> shows which caps that account gets (its own entry or the default);
// it reads only the environment, never that account's data.
export async function GET(req: NextRequest) {
  const secret = process.env.AUTOPILOT_TICK_SECRET
  const got = req.headers.get('authorization') ?? ''
  const want = `Bearer ${secret}`
  // compare BYTES: a non-ASCII header can match the string length but not the byte length (timingSafeEqual would throw)
  const a = Buffer.from(got), b = Buffer.from(want)
  if (!secret || a.length !== b.length || !timingSafeEqual(a, b)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const tenant = req.nextUrl.searchParams.get('tenant')
  if (tenant !== null && !TENANT_ID.test(tenant)) return NextResponse.json({ error: 'invalid_tenant' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  return NextResponse.json(await spendCapsCheck(process.env, { tenant }), { headers: { 'Cache-Control': 'no-store' } })
}
