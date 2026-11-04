// Tenant-load tick harness (test/helpers/tenant-load-tick-loader.mjs): the route's '@/lib/scan/runner' is the real
// runner, except that kickRunner gets the test's RunDeps (stubbed providers and page fetcher, so no network and no spend).
import type Database from 'better-sqlite3'
import { kickRunner as realKickRunner, type RunDeps } from '../../lib/scan/runner.ts'
export * from '../../lib/scan/runner.ts'
export function kickRunner(db: Database.Database, deps: RunDeps = {}): Promise<void> {
  return realKickRunner(db, { ...((globalThis as { __tenantLoadDeps?: RunDeps }).__tenantLoadDeps ?? {}), ...deps })
}
