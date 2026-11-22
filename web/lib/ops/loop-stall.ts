// #1463: pages and scans share this process's event loop (scans run in-process on better-sqlite3, which is synchronous). A long
// synchronous stretch holds every page render - reloads sat ~24s with no request answered, while the backend was fast before and
// after. No timer can fire during the stretch, so the session-check deadline and the page's stall watch cannot help. This watch
// measures the loop's late wake-ups and writes one journal line per stall past LOOP_STALL_MS, naming the scans running at that moment.
export const LOOP_STALL_MS = 1000
const TICK_MS = 250

export function loopStallLine(blockedMs: number, scans: string[], context: StallContext = {}): string | null {
  if (blockedMs < LOOP_STALL_MS) return null
  return JSON.stringify({ level: 'warn', type: 'event_loop_stall', blocked_ms: Math.round(blockedMs), scans, ...context })
}

// #1463 (follow-up): a stall with no scan running still needs a cause. Each line also carries the process memory at wake-up
// (a GC pause under memory pressure shows as a large heap/RSS) and the requests that started just before or during the window
// (id, method, route template: the same fields the request log prints, lib/ops/request-log.ts). proxy.ts and the pages are
// bundled apart, so the recent-request list lives on globalThis.
type StallContext = { heap_used_mb?: number; heap_total_mb?: number; rss_mb?: number; recent_requests?: { request_id: string; method: string; path: string; ms_before_wake: number }[] }
type Recent = { id: string; method: string; path: string; at: number }
const G = globalThis as typeof globalThis & { __dazlRecentRequests?: Recent[] }
const RECENT_MAX = 20
export function noteRecentRequest(id: string, method: string, path: string, at = performance.now()): void {
  const r = (G.__dazlRecentRequests ??= [])
  r.push({ id, method, path, at })
  if (r.length > RECENT_MAX) r.splice(0, r.length - RECENT_MAX)
}
export function stallContext(from: number, to: number): StallContext {
  const m = process.memoryUsage(), mb = (n: number) => Math.round(n / 1048576)
  const recent = (G.__dazlRecentRequests ?? []).filter(r => r.at >= from - 5000 && r.at <= to)
    .map(r => ({ request_id: r.id, method: r.method, path: r.path, ms_before_wake: Math.round(to - r.at) }))
  return { heap_used_mb: mb(m.heapUsed), heap_total_mb: mb(m.heapTotal), rss_mb: mb(m.rss), recent_requests: recent }
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
    const now = performance.now(), blocked = now - last - TICK_MS
    let line: string | null = null
    try { line = loopStallLine(blocked, scansDuring(last, now), blocked >= LOOP_STALL_MS ? stallContext(last, now) : {}) } catch { /* the watch never breaks the app */ }
    last = now
    if (line) log(line)
  }, TICK_MS)
  t.unref?.()
}
