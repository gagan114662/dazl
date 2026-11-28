import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { readCompetitors, readCompetitorPages, setCompetitors, type CompetitorEntry } from '@/lib/signals/competitor-reddit'
import { hasExtension } from '@/lib/linkedin-tasks/buyers'
import { denied } from '@/lib/workspace-access'
import { audit } from '@/lib/audit-route'

// The competitor list drives the Reddit complaint search; each competitor may also carry its LinkedIn page (#1588),
// which dazl Connect reads the competitor's own posts from. Names only otherwise - no credentials.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = await getDb()
  return NextResponse.json({ competitors: await readCompetitors(db, user.tenantId), pages: await readCompetitorPages(db, user.tenantId), connect: await hasExtension(db, user.tenantId) })
}

export async function PUT(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'configure'); if (no) return no
  const body = await req.json().catch(() => null) as { competitors?: unknown } | null
  // A name, or a name with its LinkedIn page (#1588); plain names stay valid, as they always were.
  if (!Array.isArray(body?.competitors) || !body!.competitors.every(e => typeof e === 'string' || (!!e && typeof e === 'object' && !Array.isArray(e))))
    return NextResponse.json({ error: 'competitors must be an array of names, each with an optional LinkedIn page' }, { status: 400 })
  const r = await setCompetitors(await getDb(), user.tenantId, body!.competitors as CompetitorEntry[])
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
  await audit(user, req, { action: 'settings.changed', resource: 'competitors', summary: { count: r.names.length, pages: r.pages.length } })
  return NextResponse.json({ competitors: r.names, pages: r.pages })
}
