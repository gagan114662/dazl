// Node-only (kept out of instrumentation.ts so the bundler's Edge analysis never sees process.on).
// Uncaught exceptions are recorded through the monitor event, which does not change whether the process exits.
// Unhandled promise rejections (a scan or worker promise nobody awaited) go through the scrubbed error monitor too.
// Recording must not change what the process does next: Next registers its own unhandledRejection listener, which logs
// and keeps serving. If this listener is the only one when a rejection arrives, it rethrows after recording, so Node's
// default (an uncaught exception, which exits) still happens.
import { captureError } from './errors.ts'

let installed = false
export function recordProcessErrors(): void {
  if (installed) return
  installed = true
  process.on('uncaughtExceptionMonitor', (e, origin) => { captureError(e, { source: 'process', where: origin }) })
  const listener = (e: unknown) => {
    captureError(e, { source: 'process', where: 'unhandledRejection' })
    if (process.listeners('unhandledRejection').every(l => l === listener)) throw e
  }
  process.on('unhandledRejection', listener)
}
