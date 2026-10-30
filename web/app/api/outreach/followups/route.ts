import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { followupOverview, FollowupQueryError, parseFollowupQuery } from '@/lib/outreach/followups'

// The follow-ups page, paginated and filtered on the server (#369): ?job_id=<play>&status=all|active|stopped
// &cursor=<next_cursor>&sent_cursor=<sent_next_cursor>&limit=1..100. counts are over every matching thread.
export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  try {
    return NextResponse.json(await followupOverview(await getDb(), user.tenantId, parseFollowupQuery(req.nextUrl.searchParams)))
  } catch (e) {
    if (e instanceof FollowupQueryError) return NextResponse.json({ error: e.code === 'bad_cursor' ? 'That page link is no longer valid. Reload the list.' : 'Unknown status filter', code: e.code }, { status: 400 })
    throw e
  }
}
