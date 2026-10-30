// Route-side role check (docs/design/workspaces.md). Every session route handler that does more than read calls
// denied(user, action) right after the sign-in check; test/tenant-isolation-manifest.ts names the action per handler.
import { NextResponse } from 'next/server'
import { can } from './workspaces.ts'
import type { Action, Role } from './workspaces.ts'
import { MemberError, MEMBER_ERROR_STATUS } from './workspace-members.ts'
import { FRESH_AUTH_S } from './sessions.ts'


// 403 when the member's role in this workspace does not allow `action`; null when it does. The same body for every
// refusal, so it says nothing about the resource the caller named.
export function denied(user: { role: Role }, action: Action): NextResponse | null {
  return can(user.role, action) ? null : NextResponse.json({ error: 'forbidden', needs: action }, { status: 403 })
}

// 403 { error: 'reauth_required' } when this session last signed in (or re-authenticated) more than FRESH_AUTH_S ago:
// changing secrets, billing or members needs fresh proof (POST /api/auth/reauth, or Google again). null when fresh.
export function stale(user: { authedAt: number }, now = Math.floor(Date.now() / 1000)): NextResponse | null {
  return now - user.authedAt <= FRESH_AUTH_S ? null : NextResponse.json({ error: 'reauth_required' }, { status: 403 })
}

// For the /api/workspace routes: a member-management refusal as HTTP, and an id as the schema writes them.
export const isId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v)
export function memberFail(e: unknown): NextResponse {
  if (e instanceof MemberError) return NextResponse.json({ error: e.code }, { status: MEMBER_ERROR_STATUS[e.code] })
  throw e
}

