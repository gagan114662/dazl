import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { denied } from '@/lib/workspace-access'
import type { Action } from '@/lib/workspaces'
import { audit } from '@/lib/audit-route'
import { cleanupInboxFixture, inboxFixtureRefusal, InboxFixtureError, seedInboxFixture } from '@/lib/outreach/inbox-fixture'

// Test-only, NO-SEND Inbox fixture (#369, lib/outreach/inbox-fixture.ts). POST seeds the labelled synthetic set (more
// threads than one Inbox page, plus one bounce_review notice); DELETE removes exactly those rows. Off unless
// OUTREACH_INBOX_FIXTURE=1, and then only for the tenant named by OUTREACH_TEST_TENANT_ID. Signed-in owners only; the
// tenant is always the session's (the request body is never read). Every refusal past the role check is audited with
// its reason and answers the same 403, so the response does not say whether the flag is on.
type Op = 'seed' | 'cleanup'
async function guard(req: NextRequest, op: Op, action: Action) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, action); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!(await rateLimit(`inbox-fixture:${user.tenantId}`, 10, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const event = `inbox_fixture.${op}`
  const refuse = async (reason: string) => {
    await audit(user, req, { action: event, resource: 'inbox_fixture', decision: 'denied', summary: { reason } })
    return NextResponse.json({ error: 'fixture_unavailable' }, { status: 403 })
  }
  const why = inboxFixtureRefusal(user.tenantId)
  if (why) return refuse(why)
  const db = await getDb()
  try {
    if (op === 'seed') {
      const r = await seedInboxFixture(db, user.tenantId)
      await audit(user, req, { action: event, resource: 'inbox_fixture', id: r.job_id, summary: { created: r.created, threads: r.threads } })
      return NextResponse.json(r)
    }
    const r = await cleanupInboxFixture(db, user.tenantId)
    await audit(user, req, { action: event, resource: 'inbox_fixture', summary: { ...r.deleted } })
    return NextResponse.json(r)
  } catch (e) {
    if (e instanceof InboxFixtureError) return refuse(e.code)
    throw e
  }
}

export async function POST(req: NextRequest) { return guard(req, 'seed', 'owners') }
export async function DELETE(req: NextRequest) { return guard(req, 'cleanup', 'owners') }
