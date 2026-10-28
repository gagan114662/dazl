// Wiring for the health routes: the real store, the real SQLite file, the PG migrations this build ships.
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { getDb } from '../db/client.ts'
import { getAuthDb } from '../auth-db.ts'
import { resolveServedCommit } from '../commit-marker.ts'
import { readiness } from './health.ts'

// The server runs from web/ (ops/safe_launch.py); list the migration files in the source tree, not the bundle. The path
// is statically scoped (a dynamic one makes the bundler trace the whole project) and only the NNNN_ prefixes are read;
// lib/db/migrate-pg.ts validates the files themselves when they are applied.
let shipped: number[] | undefined
const migrations = () => (shipped ??= readdirSync(path.join(process.cwd(), 'lib', 'db', 'migrations', 'pg'))
  .map(f => /^(\d{4})_[a-z0-9_]+\.sql$/.exec(f)?.[1]).filter((v): v is string => !!v).map(Number))

export async function readyResponse(): Promise<NextResponse> {
  const r = await readiness({ db: getDb, sqlite: getAuthDb, migrations })
  return NextResponse.json({ ...r, commit: resolveServedCommit() }, { status: r.ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } })
}
