// Shared boot teardown for worker tests (#933): terminate and REAP a spawned worker with real bounds, never
// fire-and-forget - an unreaped child can still hold its port when the next attempt starts.
import type { ChildProcess } from 'node:child_process'

// SIGTERM, up to 2s, then SIGKILL, up to 2s, then FAIL with evidence: a suite must never hang on an unreapable
// child. Settles on 'exit' OR 'close' (a failed spawn can close without ever exiting) and records a spawn
// 'error' (never an unhandled rejection). Listeners go in BEFORE the first signal, so a child that dies between
// the liveness check and the kill cannot slip past them. Timers are NOT unref'd: an awaited reap must hold the
// event loop for its bound. Every timer is cleared on settle and fires itself on timeout; all listeners are
// removed before returning or throwing.
export async function reap(c: ChildProcess): Promise<void> {
  if (c.exitCode !== null || c.signalCode !== null) return
  let settled = false, spawnErr: unknown = null
  const done = new Promise<void>(resolve => {
    const finish = () => { if (!settled) { settled = true; resolve() } }
    c.once('exit', finish)
    c.once('close', finish)
    c.once('error', (e: unknown) => { spawnErr = e; finish() })
  })
  const wait = (ms: number) => new Promise<boolean>(r => {
    const t = setTimeout(() => r(false), ms)
    void done.then(() => { clearTimeout(t); r(true) })
  })
  c.kill()
  if (!await wait(2000)) {
    c.kill('SIGKILL')
    if (!await wait(2000)) {
      c.removeAllListeners()
      throw new Error(`worker child still alive after SIGTERM + 2s and SIGKILL + 2s${spawnErr ? `; spawn error: ${String(spawnErr)}` : ''}`)
    }
  }
  c.removeAllListeners()
}
