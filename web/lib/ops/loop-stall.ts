// #1463: pages and scans share this process's event loop (scans run in-process on better-sqlite3, which is synchronous). A long
// synchronous stretch holds every page render - reloads sat ~24s with no request answered, while the backend was fast before and
// after. No timer can fire during the stretch, so the session-check deadline and the page's stall watch cannot help. This watch
// measures the loop's late wake-ups and writes one journal line per stall past LOOP_STALL_MS, naming the scans running at that moment.
export const LOOP_STALL_MS = 1000
const TICK_MS = 250

export function loopStallLine(blockedMs: number, scans: string[]): string | null {
  if (blockedMs < LOOP_STALL_MS) return null
  return JSON.stringify({ level: 'warn', type: 'event_loop_stall', blocked_ms: Math.round(blockedMs), scans })
}

let installed = false
export function installLoopStallWatch(running: () => string[], log: (l: string) => void = l => console.warn(l)): void {
  if (installed) return
  installed = true
  let last = performance.now()
  const t = setInterval(() => {
    const now = performance.now(), line = loopStallLine(now - last - TICK_MS, running())
    last = now
    if (line) log(line)
  }, TICK_MS)
  t.unref?.()
}
