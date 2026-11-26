// Wiring for the health routes: the configured store and the PG migrations this build ships.
import { deletionCheck, launchRequired, mailCheck } from './launch-checks.ts'
import { outboxReadiness } from '../system-mail.ts'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { getDb } from '../db/client.ts'
import { resolveServedCommit } from '../commit-marker.ts'
import { dbHealth, readiness } from './health.ts'
import { RAW_SQLITE_MODULES } from '../db/pg-port-status.ts'
import { dbBackend, instanceId } from './instance.ts'

// The server runs from web/ (ops/safe_launch.py); list the migration files in the source tree, not the bundle. The path
// is statically scoped (a dynamic one makes the bundler trace the whole project) and only the NNNN_ prefixes are read;
// lib/db/migrate-pg.ts validates the files themselves when they are applied.
let shipped: number[] | undefined
const migrations = () => (shipped ??= readdirSync(path.join(process.cwd(), 'lib', 'db', 'migrations', 'pg'))
  .map(f => /^(\d{4})_[a-z0-9_]+\.sql$/.exec(f)?.[1]).filter((v): v is string => !!v).map(Number))

// Liveness (/api/health/live): the process answers, with the commit it serves, its instance id and the store it is
// configured for (lib/ops/instance.ts). Touches no store, so a slow database never gets a healthy process restarted.
export function liveResponse(): NextResponse {
  return NextResponse.json({ ok: true, commit: resolveServedCommit(), instance: instanceId(), db: dbBackend() }, { headers: { 'Cache-Control': 'no-store' } })
}

// Health (/api/health): only the configured backend is probed.
export async function healthResponse(): Promise<NextResponse> {
  const postgres = dbBackend() === 'postgres'
  const h = await dbHealth({ sqlite: postgres ? null : getDb, postgres: postgres ? getDb : null })
  return NextResponse.json({ ok: h.ok, commit: resolveServedCommit(), instance: instanceId(), db: dbBackend(), checks: h.checks }, { status: h.ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } })
}

export async function readyResponse(): Promise<NextResponse> {
  const r = await readiness({ db: getDb, migrations, rawSqliteModules: () => Object.keys(RAW_SQLITE_MODULES).length, env: () => process.env, mail: () => mailCheck(process.env), deletion: () => deletionCheck(process.env), outbox: async () => outboxReadiness(await getDb()), launchRequired: () => launchRequired(process.env) })
  return NextResponse.json({ ...r, commit: resolveServedCommit(), instance: instanceId(), db: dbBackend() }, { status: r.ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } })
}
