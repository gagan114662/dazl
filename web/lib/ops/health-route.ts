// Wiring for the health routes: the real store, the real SQLite file, the PG migrations this build ships.
import path from 'node:path'
import { NextResponse } from 'next/server'
import { getDb } from '../db/client.ts'
import { getAuthDb } from '../auth-db.ts'
import { loadMigrations } from '../db/migrate-pg.ts'
import { resolveServedCommit } from '../commit-marker.ts'
import { readiness } from './health.ts'

// The server runs from web/ (ops/safe_launch.py); read the migration files from the source tree, not the bundle.
let shipped: number[] | undefined
const migrations = () => (shipped ??= loadMigrations(path.join(process.cwd(), 'lib', 'db', 'migrations', 'pg')).map(m => m.version))

export async function readyResponse(): Promise<NextResponse> {
  const r = await readiness({ db: getDb, sqlite: getAuthDb, migrations })
  return NextResponse.json({ ...r, commit: resolveServedCommit() }, { status: r.ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } })
}
