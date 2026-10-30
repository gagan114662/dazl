// The audit trail (lib/audit.ts) from a route handler: the workspace and the actor come from the caller's session, the
// correlation id from the request (x-request-id, lib/ops/request-log.ts). Called after the change succeeded, with only
// short scalar facts about it; lib/audit.ts drops anything that looks like a secret or message content.
//
// A failed audit write never undoes or fails the change it describes: it is reported like any other server error
// (captureError), so a missing event is an alert, not a silent gap.
import { getDb } from './db/client.ts'
import { record } from './audit.ts'
import { captureError } from './ops/errors.ts'
import { requestIdOf } from './ops/request-log.ts'

// SessionUser (lib/auth-db.ts). The event's workspace is the one the route acted in: routes act in user.id until they
// move to user.tenantId (#424), and that move removes id, so every call here moves with its route. actorId is the
// account acting.
export type AuditUser = { id: string; actorId?: string }
type Req = { headers: { get(name: string): string | null } }
export type RouteEvent = { action: string; resource: string; id?: string | null; summary?: Record<string, unknown>; decision?: 'allowed' | 'denied' }

export async function audit(user: AuditUser, req: Req | null, e: RouteEvent): Promise<void> {
  const tenantId = user.id
  try {
    await record(await getDb(), {
      tenantId, actorId: user.actorId ?? user.id, action: e.action, resourceType: e.resource, resourceId: e.id ?? null,
      summary: e.summary, decision: e.decision ?? 'allowed', correlationId: req ? requestIdOf(req) ?? null : null,
    })
  } catch (err) { captureError(err, { source: 'route', where: `audit:${e.action}`, tenantId }) }
}
