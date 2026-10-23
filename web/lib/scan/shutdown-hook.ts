// Node-only: registers the SIGTERM handler. Kept out of instrumentation.ts so the bundler's Edge analysis never sees process.once.
import { requeueInFlightForShutdown, hasInFlight } from './runner.ts'
import { getAuthDb } from '../auth-db.ts' // same singleton connection getScanDb wraps; rows to requeue exist only if it was already opened and migrated

// Requeues this process's own running scans when it exits.
export function installShutdownRequeue(): void {
  // 'exit' (not a SIGTERM listener): adding a SIGTERM listener would replace Node's default terminate behaviour if Next's own
  // handler were absent, and would requeue while this process is still alive and its provider call still in flight, letting the
  // next process claim the row early. 'exit' fires synchronously from process.exit (Next's SIGTERM cleanup ends in process.exit(143)),
  // i.e. at the moment this process stops running, so there is no live old attempt left to overlap. SIGKILL has no exit event: lease reaper.
  process.once('exit', () => {
    try { if (hasInFlight()) requeueInFlightForShutdown(getAuthDb()) } catch { /* lease reaper is the fallback */ }
  })
}
