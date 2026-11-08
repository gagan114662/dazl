// Shared boot teardown for worker tests (#933): terminate and REAP a spawned worker with real bounds, never
// fire-and-forget - an unreaped child can still hold its port when the next attempt starts.
import type { ChildProcess } from 'node:child_process'

// SIGTERM, up to 2s, then SIGKILL, up to 2s, then FAIL with evidence: a suite must never hang on an unreapable
// child, and an 'error' event is NOT proof of death - a failed kill on a LIVE child (EPERM) only records here,
// the bounded waits continue, and a child that still never exits is a diagnostic throw, never a silent success.
// Early settle requires provable termination: 'exit', or 'close'/'error' only when the child cannot be alive
// (exit/signal already known, or pid undefined - a spawn that never started). Listeners go in BEFORE the first
// signal so a child that dies between the liveness check and the kill cannot slip past them; only reap's OWN
// named listeners are removed afterwards - a caller's listeners on the child are never touched. Timers hold
// the loop only for their bound (an awaited reap must not unref itself away) and are cleared on settle.
export async function reap(c: ChildProcess): Promise<void> {
  if (c.exitCode !== null || c.signalCode !== null) return
  const dead = () => c.exitCode !== null || c.signalCode !== null || c.pid === undefined
  let settled = false, killErr: unknown = null, resolveDone!: () => void
  const done = new Promise<void>(resolve => { resolveDone = resolve })
  const finish = () => { if (!settled) { settled = true; cleanup(); resolveDone() } }
  const onExit = () => finish()
  const onClose = () => { if (dead()) finish() }
  const onError = (e: unknown) => { killErr = e; if (dead()) finish() }
  const cleanup = () => { c.off('exit', onExit); c.off('close', onClose); c.off('error', onError) }
  c.on('exit', onExit); c.on('close', onClose); c.on('error', onError)
  const wait = (ms: number) => new Promise<boolean>(r => {
    const t = setTimeout(() => r(false), ms)
    void done.then(() => { clearTimeout(t); r(true) })
  })
  c.kill()
  if (!await wait(2000)) {
    c.kill('SIGKILL')
    if (!await wait(2000)) {
      cleanup()
      throw new Error(`worker child still alive after SIGTERM + 2s and SIGKILL + 2s${killErr ? `; kill error: ${String(killErr)}` : ''}`)
    }
  }
}
