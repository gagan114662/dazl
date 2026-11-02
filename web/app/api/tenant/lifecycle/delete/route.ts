import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { denied, stale } from '@/lib/workspace-access'
import { deleteTenant, tombstone, ALWAYS_RETAINED } from '@/lib/tenant/lifecycle'

// Request (or resume) deletion of the whole account. Owner role only, fresh sign-in, and the confirmation must
// name the session's own tenant id - the route never takes a tenant from the caller. The policy choice on
// opt-outs is required up front ('retain' keeps the suppression list so those addresses are never mailed again;
// 'erase' removes it with everything else). The five-step deletion runs now; a failed step rolls back as a whole
// and the same request resumes it (the tombstone records the policy, so a resume sends no policy).
export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'owners'); if (no) return no
  const old = stale(user); if (old) return old
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  if (body?.confirm_tenant !== user.tenantId) return NextResponse.json({ error: 'confirm_tenant must name this workspace exactly' }, { status: 400 })
  const db = await getDb()
  const existing = await tombstone(db, user.tenantId)
  const sup = body?.suppressions
  if (!existing && sup !== 'retain' && sup !== 'erase') return NextResponse.json({ error: 'suppressions must be "retain" or "erase"' }, { status: 400 })
  try {
    const t = existing
      ? await deleteTenant(db, user.tenantId) // resume: the recorded policy holds; a second one must not silently replace it
      : await deleteTenant(db, user.tenantId, {
          requestedBy: `user:${user.actorId}`,
          policy: {
            suppressions: sup as 'retain' | 'erase',
            retainTables: Array.isArray(body?.retain_tables) ? body.retain_tables.filter((x: unknown) => typeof x === 'string').slice(0, 20) : undefined,
          },
        })
    return NextResponse.json({ ok: true, state: t.state, retained: t.retained ? JSON.parse(t.retained) : null, completed_at: t.completed_at, always_retained: Object.keys(ALWAYS_RETAINED) })
  } catch (e) {
    const t = await tombstone(db, user.tenantId)
    // a step failed: report where it stands; the same POST resumes it
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'deletion failed', state: t?.state ?? null }, { status: 409 })
  }
}
