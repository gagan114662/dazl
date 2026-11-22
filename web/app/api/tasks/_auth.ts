// The dazl Connect extension's bearer auth for the task routes (#1122). No session cookie and no CORS headers: only the extension
// (which holds the workspace's device token from pairing, and has a host permission for dazl) can call these routes.
// ONE gate: the workspace connected LinkedIn (a paired device whose member may still configure it) and accepted the LinkedIn notice.
import type { NextRequest } from 'next/server'
import { getDb } from '@/lib/db/client'
import { authDevice } from '@/lib/advanced/linkedin-connect'
import { readConsent } from '@/lib/advanced'
import { clientIp, rateLimit } from '@/lib/rate-limit'
export const bearer = (req: NextRequest) => /^Bearer ([A-Za-z0-9._-]{10,200})$/.exec(req.headers.get('authorization') ?? '')?.[1] ?? null
export async function extTenant(req: NextRequest): Promise<{ tenantId: string } | { status: number; error: string }> {
  if (!(await rateLimit(`ext-task-ip:${clientIp(req)}`, 120, 10 * 60 * 1000)).ok) return { status: 429, error: 'Too many requests' }
  const t = bearer(req)
  const db = await getDb()
  const dev = t ? await authDevice(db, t) : null
  if (!dev) return { status: 401, error: 'unauthorized' }
  if (!(await readConsent(db, dev.tenantId, 'linkedin'))) return { status: 403, error: 'Accept the LinkedIn notice in dazl Settings first' }
  return { tenantId: dev.tenantId }
}
