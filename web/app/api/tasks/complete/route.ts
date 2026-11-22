// POST /api/tasks/complete (#1122): what the extension read on the page of a task it was given. { id, people } for a People page or
// a post, { id, person } for a profile, or { id, error } with a named reason. Only the workspace's own task, only while it is out.
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db/client'
import { completeTask } from '@/lib/linkedin-tasks/store'
import { onCompanyPeopleResult } from '@/lib/linkedin-tasks/buyers'
import { extTenant } from '@/app/api/tasks/_auth'

export async function POST(req: NextRequest) {
  const a = await extTenant(req)
  if ('error' in a) return NextResponse.json({ error: a.error }, { status: a.status })
  const text = await req.text().catch(() => '')
  if (text.length > 200_000) return NextResponse.json({ error: 'Too large' }, { status: 413 })
  let body: { id?: unknown; people?: unknown; person?: unknown; error?: unknown } | null = null
  try { body = JSON.parse(text) } catch { body = null }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const db = await getDb()
  const r = await completeTask(db, a.tenantId, body.id, body)
  // #830: a task that is not this workspace's own (or does not exist) is not found; the workspace's own stale task stays a 409
  if (r === 'not_leased') return typeof body.id === 'string' && await db.get('SELECT 1 AS x FROM li_tasks WHERE id = ? AND tenant_id = ?', [body.id, a.tenantId])
    ? NextResponse.json({ error: 'not_leased' }, { status: 409 }) : NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (r === 'bad_result') return NextResponse.json({ error: 'bad_result' }, { status: 400 })
  if (r === 'stored') await onCompanyPeopleResult(db, a.tenantId, body.id as string)
  return NextResponse.json({ ok: true, result: r })
}
