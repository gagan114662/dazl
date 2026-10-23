// Node-only: registers the SIGTERM handler. Kept out of instrumentation.ts so the bundler's Edge analysis never sees process.once.
import { requeueInFlightForShutdown, hasInFlight } from './runner.ts'
import { getAuthDb } from '../auth-db.ts' // same singleton connection getScanDb wraps; rows to requeue exist only if it was already opened and migrated

export function installShutdownRequeue(): void {
  process.once('SIGTERM', () => {
    try { if (hasInFlight()) requeueInFlightForShutdown(getAuthDb()) } catch { /* lease reaper is the fallback */ }
  })
}
