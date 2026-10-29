// Route-side role check (docs/design/workspaces.md). Every session route handler that does more than read calls
// denied(user, action) right after the sign-in check; test/tenant-isolation-manifest.ts names the action per handler.
import { NextResponse } from 'next/server'
import { can } from './workspaces.ts'
import type { Action, Role } from './workspaces.ts'
import { MemberError, MEMBER_ERROR_STATUS } from './workspace-members.ts'
import { FRESH_AUTH_S } from './sessions.ts'
import { record } from './audit.ts'
import { getDb } from './db/client.ts'
import { captureError } from './ops/errors.ts'

// Who is acting, for the audit trail (lib/audit.ts): the session's actor and workspace, and the request id.
type Actor = { actorId: string; tenantId: string; correlationId?: string | null }

// Records an allowed action at the route layer, after it succeeded. A failure to write the event never undoes the
// action or fails the response; it is reported as an error instead, never dropped silently.
export async function audit(user: Actor, action: string, resourceType: string, resourceId?: string | null, summary?: Record<string, unknown>): Promise<void> {
  try {
    await record(await getDb(), { tenantId: user.tenantId, actorId: user.actorId, correlationId: user.correlationId, action, resourceType, resourceId: resourceId ?? null, summary })
  } catch (e) { captureError(e, { source: 'route', where: `audit:${action}`, tenantId: user.tenantId }) }
}
// For a handler with several success returns: `const done = audited(user, 'credential.saved', 'llm_key')`, then
// `return done({ ok: true, vendor })` in place of NextResponse.json (a third argument adds summary fields that are not
// in the response). The event's summary is the response body, redacted
// (lib/audit.ts redact: a secret in the response, such as a rotated signing secret, never reaches the trail).
export function audited(user: Actor, action: string, resourceType: string, resourceId?: string | null) {
  return async (body: Record<string, unknown>, init?: ResponseInit, extra?: Record<string, unknown>): Promise<NextResponse> => {
    await audit(user, action, resourceType, resourceId, { ...body, ...extra })
    return NextResponse.json(body, init)
  }
}
const refused = async (user: Partial<Actor>, action: string, summary: Record<string, unknown>) => {
  if (!user.actorId || !user.tenantId) return
  try {
    await record(await getDb(), { tenantId: user.tenantId, actorId: user.actorId, correlationId: user.correlationId, action, resourceType: 'route', decision: 'denied', summary })
  } catch (e) { captureError(e, { source: 'route', where: `audit:${action}`, tenantId: user.tenantId }) }
}

// 403 when the member's role in this workspace does not allow `action`; null when it does. The same body for every
// refusal, so it says nothing about the resource the caller named. Each refusal is a denied audit event
// (policy.denied; correlation_id links it to the request log line, which names the route).
export async function denied(user: { role: Role } & Partial<Actor>, action: Action): Promise<NextResponse | null> {
  if (can(user.role, action)) return null
  await refused(user, 'policy.denied', { needs: action, role: user.role })
  return NextResponse.json({ error: 'forbidden', needs: action }, { status: 403 })
}

// 403 { error: 'reauth_required' } when this session last signed in (or re-authenticated) more than FRESH_AUTH_S ago:
// changing secrets, billing or members needs fresh proof (POST /api/auth/reauth, or Google again). null when fresh.
export async function stale(user: { authedAt: number } & Partial<Actor>, now = Math.floor(Date.now() / 1000)): Promise<NextResponse | null> {
  if (now - user.authedAt <= FRESH_AUTH_S) return null
  await refused(user, 'policy.reauth_required', { signed_in_s_ago: now - user.authedAt })
  return NextResponse.json({ error: 'reauth_required' }, { status: 403 })
}

// For the /api/workspace routes: a member-management refusal as HTTP, and an id as the schema writes them.
export const isId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v)
export function memberFail(e: unknown): NextResponse {
  if (e instanceof MemberError) return NextResponse.json({ error: e.code }, { status: MEMBER_ERROR_STATUS[e.code] })
  throw e
}
