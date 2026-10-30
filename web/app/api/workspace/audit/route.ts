import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { cursorOf, parseCursor, searchAudit } from '@/lib/audit'
import type { AuditRow } from '@/lib/audit'
import { rateLimit } from '@/lib/rate-limit'
import { audit } from '@/lib/audit-route'
import { denied } from '@/lib/workspace-access'

// The workspace's audit trail, newest first, for its owners and admins: ?action= (prefix, e.g. credential.), ?actor=,
// ?limit= (up to 1000) and ?cursor= (the `next` of the previous page); ?format=csv downloads every matching event. The
// workspace is always the caller's own, from the session: no parameter names another one. No route writes, edits or
// deletes events.
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  // a cell a spreadsheet would run as a formula is kept as text
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}
// Retention keeps at most 400 days; this bounds one download's memory all the same, and says so when it stops short.
const CSV_MAX = 100_000
const COLUMNS = ['at', 'actor_id', 'actor_kind', 'action', 'resource_type', 'resource_id', 'decision', 'summary', 'correlation_id'] as const

// seq is an ordering detail of the cursor, not part of the event
const publicRow = (e: AuditRow): Omit<AuditRow, 'seq'> => { const r: Partial<AuditRow> = { ...e }; delete r.seq; return r as Omit<AuditRow, 'seq'> }

export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  // this route acts in the session's workspace (tenantId), so its own events are that workspace's
  const no = denied(user, 'members')
  if (no) {
    // a refusal is recorded at most once a minute per member, so repeating it cannot flood the workspace's trail
    if ((await rateLimit(`audit-denied:${user.tenantId}:${user.actorId}`, 1, 60 * 1000)).ok)
      await audit(user, req, { action: 'audit.read', resource: 'audit', decision: 'denied', summary: { role: user.role ?? null } })
    return no
  }
  const q = req.nextUrl.searchParams
  const num = (k: string) => { const n = Number(q.get(k)); return Number.isSafeInteger(n) && n > 0 ? n : undefined }
  const action = q.get('action') ?? undefined, actor = q.get('actor') ?? undefined
  if (action !== undefined && !/^[a-z_.]{1,64}$/.test(action)) return NextResponse.json({ error: 'bad_action' }, { status: 400 })
  if (actor !== undefined && !/^[A-Za-z0-9_.@-]{1,80}$/.test(actor)) return NextResponse.json({ error: 'bad_actor' }, { status: 400 })
  const cursor = q.get('cursor'), after = parseCursor(cursor)
  if (cursor !== null && !after) return NextResponse.json({ error: 'bad_cursor' }, { status: 400 })
  const db = await getDb()
  if (q.get('format') !== 'csv') {
    const limit = Math.max(1, Math.min(num('limit') ?? 100, 1000))
    const events = await searchAudit(db, user.tenantId, { action, actor, after, limit })
    return NextResponse.json({ events: events.map(publicRow), next: events.length === limit ? cursorOf(events[events.length - 1]) : null })
  }
  // the whole trail (every matching event), a page at a time
  const events: AuditRow[] = []
  for (let page: AuditRow[] = [], next = after; events.length <= CSV_MAX; next = { at: page[page.length - 1].at, seq: page[page.length - 1].seq, id: page[page.length - 1].id }) {
    page = await searchAudit(db, user.tenantId, { action, actor, after: next, limit: 1000 })
    events.push(...page)
    if (page.length < 1000) break
  }
  const truncated = events.length > CSV_MAX
  if (truncated) events.length = CSV_MAX
  await audit(user, req, { action: 'export.audit', resource: 'audit', summary: { rows: events.length, truncated } })
  const body = [COLUMNS.join(','), ...events.map(e => COLUMNS.map(c => csvCell(c === 'at' ? new Date(e.at * 1000).toISOString() : e[c])).join(','))].join('\n') + '\n'
  return new NextResponse(body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="dazl-audit.csv"', 'cache-control': 'no-store', ...(truncated ? { 'x-audit-truncated': '1' } : {}) } })
}
