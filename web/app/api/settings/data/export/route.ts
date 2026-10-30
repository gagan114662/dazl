import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { rateLimit } from '@/lib/rate-limit'
import { exportForTenant } from '@/lib/tenant/requests'

// The signed-in account's own data as one JSON file (lib/tenant/lifecycle.ts exportTenant: every tenant-scoped table,
// secrets redacted, session tokens left out). Each download is recorded. Three an hour per account.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const rl = await rateLimit(`export:${user.id}`, 3, 60 * 60 * 1000)
  if (!rl.ok) return NextResponse.json({ error: 'Too many exports. Try again later.' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterS) } })
  const data = await exportForTenant(await getDb(), user.id)
  return new NextResponse(JSON.stringify(data, null, 2), { headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'content-disposition': `attachment; filename="dazl-export-${data.exported_at.slice(0, 10)}.json"`,
  } })
}
