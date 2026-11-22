// The dazl LinkedIn extension's bearer auth (#1122). No session cookie and no CORS headers: only the extension (which holds the
// workspace's token and has a host permission for dazl) can call these routes.
import type { NextRequest } from 'next/server'
import { getDb } from '@/lib/db/client'
import { authExtensionToken } from '@/lib/linkedin-tasks/store'
import { clientIp, rateLimit } from '@/lib/rate-limit'
export const bearer = (req: NextRequest) => /^Bearer (dzx_[A-Za-z0-9._-]{10,200})$/.exec(req.headers.get('authorization') ?? '')?.[1] ?? null
export async function extTenant(req: NextRequest): Promise<{ tenantId: string } | { status: number; error: string }> {
  if (!(await rateLimit(`ext-task-ip:${clientIp(req)}`, 120, 10 * 60 * 1000)).ok) return { status: 429, error: 'Too many requests' }
  const t = bearer(req)
  const tenantId = t ? await authExtensionToken(await getDb(), t) : null
  return tenantId ? { tenantId } : { status: 401, error: 'unauthorized' }
}
