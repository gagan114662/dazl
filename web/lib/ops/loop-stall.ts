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

// Qodo #1529: the stall is reported after the loop wakes, when the scan that caused it may already have ended. Every scan's start and end
// are kept (the last few minutes only), so the line names each scan that was running at any point of the blocked window.
const spans = new Map<string, { start: number; end: number | null }>()
const KEEP_MS = 10 * 60_000
export function scanStarted(id: string, at = performance.now()): void { spans.set(id, { start: at, end: null }) }
export function scanEnded(id: string, at = performance.now()): void {
  const s = spans.get(id); if (s) s.end = at
  for (const [k, v] of spans) if (v.end !== null && at - v.end > KEEP_MS) spans.delete(k)
}
export function scansDuring(from: number, to: number): string[] {
  return [...spans].filter(([, s]) => s.start <= to && (s.end === null || s.end >= from)).map(([id]) => id)
}

let installed = false
export function installLoopStallWatch(log: (l: string) => void = l => console.warn(l)): void {
  if (installed) return
  installed = true
  let last = performance.now()
  const t = setInterval(() => {
    const now = performance.now(), line = loopStallLine(now - last - TICK_MS, scansDuring(last, now))
    last = now
    if (line) log(line)
  }, TICK_MS)
  t.unref?.()
}
