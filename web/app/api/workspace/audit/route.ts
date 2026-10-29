import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { searchAudit } from '@/lib/audit'
import { denied } from '@/lib/workspace-access'

// Where the workspace's audit events come from, newest first: ?action= (prefix, e.g. member.), ?actor=, ?before= (epoch
// seconds), ?limit= (up to 1000), ?format=csv to download. The workspace is always the caller's own (from the session);
// there is no way to name another one, and no route writes, edits or deletes events.
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = await denied(user, 'members'); if (no) return no
  const q = req.nextUrl.searchParams
  const num = (k: string) => { const n = Number(q.get(k)); return Number.isSafeInteger(n) && n > 0 ? n : undefined }
  const action = q.get('action') ?? undefined, actor = q.get('actor') ?? undefined
  const events = await searchAudit(await getDb(), user.tenantId, {
    action: action && /^[a-z_.]{1,64}$/.test(action) ? action : undefined,
    actor: actor && actor.length <= 80 ? actor : undefined,
    before: num('before'), limit: num('limit'),
  })
  if (q.get('format') !== 'csv') return NextResponse.json({ events })
  const cols = ['at', 'actor_id', 'actor_kind', 'action', 'resource_type', 'resource_id', 'decision', 'summary', 'correlation_id'] as const
  const body = [cols.join(','), ...events.map(e => cols.map(c => csvCell(c === 'at' ? new Date(e.at * 1000).toISOString() : e[c])).join(','))].join('\n') + '\n'
  return new NextResponse(body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="dazl-audit.csv"', 'cache-control': 'no-store' } })
}
