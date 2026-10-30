import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { searchAudit } from '@/lib/audit'
import { audit } from '@/lib/audit-route'
import { denied } from '@/lib/workspace-access'

// The workspace's audit trail, newest first, for its owners and admins: ?action= (prefix, e.g. credential.), ?actor=,
// ?before= (epoch seconds), ?limit= (up to 1000), ?format=csv to download. The workspace is always the caller's own,
// from the session: no parameter names another one. No route writes, edits or deletes events.
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  // a cell a spreadsheet would run as a formula is kept as text
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}
const COLUMNS = ['at', 'actor_id', 'actor_kind', 'action', 'resource_type', 'resource_id', 'decision', 'summary', 'correlation_id'] as const

export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  // this route acts in the session's workspace (tenantId), so its own events are that workspace's
  const no = denied(user, 'members')
  if (no) {
    await audit(user, req, { action: 'audit.read', resource: 'audit', decision: 'denied', summary: { role: user.role ?? null } })
    return no
  }
  const q = req.nextUrl.searchParams
  const num = (k: string) => { const n = Number(q.get(k)); return Number.isSafeInteger(n) && n > 0 ? n : undefined }
  const action = q.get('action') ?? undefined, actor = q.get('actor') ?? undefined
  if (action !== undefined && !/^[a-z_.]{1,64}$/.test(action)) return NextResponse.json({ error: 'bad_action' }, { status: 400 })
  if (actor !== undefined && !/^[A-Za-z0-9_.@-]{1,80}$/.test(actor)) return NextResponse.json({ error: 'bad_actor' }, { status: 400 })
  const events = await searchAudit(await getDb(), user.tenantId, { action, actor, before: num('before'), limit: num('limit') })
  if (q.get('format') !== 'csv') return NextResponse.json({ events })
  await audit(user, req, { action: 'export.audit', resource: 'audit', summary: { rows: events.length } })
  const body = [COLUMNS.join(','), ...events.map(e => COLUMNS.map(c => csvCell(c === 'at' ? new Date(e.at * 1000).toISOString() : e[c])).join(','))].join('\n') + '\n'
  return new NextResponse(body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="dazl-audit.csv"', 'cache-control': 'no-store' } })
}
