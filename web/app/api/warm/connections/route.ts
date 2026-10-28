import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { connectionImportStatus, deleteConnections, importConnectionsCsv, MAX_IMPORT_ROWS } from '@/lib/warm/connections'

// The user's OWN LinkedIn connections export (Settings -> Data privacy -> Connections.csv),
// uploaded intentionally by the user. Nothing is fetched, scraped or synced - this file is
// the only source of first-degree paths, and deleting it removes every imported row.

const MAX_CSV_BYTES = 5 * 1024 * 1024

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  return NextResponse.json(await connectionImportStatus(await getDb(), user.id))
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad origin' }, { status: 403 })
  if (!(await rateLimit(`warm-import:${user.id}`, 10, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const body = await req.json().catch(() => null) as { csv?: string; confirm_replace?: boolean } | null
  if (!body || typeof body.csv !== 'string' || body.csv.length === 0) return NextResponse.json({ error: 'csv_required' }, { status: 400 })
  if (body.csv.length > MAX_CSV_BYTES) return NextResponse.json({ error: 'csv_too_large', max_bytes: MAX_CSV_BYTES }, { status: 413 })
  const db = await getDb()
  const existing = await connectionImportStatus(db, user.id)
  // Replace must be a visible, deliberate choice: the client shows the count being replaced.
  if (existing.count > 0 && body.confirm_replace !== true) {
    return NextResponse.json({ error: 'replace_needs_confirm', existing_count: existing.count, imported_at: existing.imported_at }, { status: 409 })
  }
  const result = await importConnectionsCsv(db, user.id, body.csv)
  if (result.imported === 0 && result.replaced === 0 && result.skipped > 0) return NextResponse.json({ error: 'no_valid_rows', skipped: result.skipped }, { status: 422 })
  return NextResponse.json({ ...result, max_rows: MAX_IMPORT_ROWS })
}

export async function DELETE(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad origin' }, { status: 403 })
  const deleted = await deleteConnections(await getDb(), user.id)
  return NextResponse.json({ deleted })
}
