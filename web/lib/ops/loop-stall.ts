<<<<<<< HEAD
// #1463: a reload sat on "Opening your workspace…" for ~24 s while a scan ran in the same process, with no request,
// no DB write and no log in the gap (prod 383ada0a, 2026-11-22 06:08:17-06:08:39Z). A blocked event loop logs nothing
// by itself, so it could not be told apart from a slow server. This monitor names every stall: a drift probe (a timer
// that should fire every INTERVAL_MS) measures how late it ran, and perf_hooks.monitorEventLoopDelay gives the worst
// delay since the last tick. A stall over STALL_MS writes ONE JSON line, `event_loop_stall`, with its duration, the
// heap and resident memory at that moment, and the requests that started just before or during it (id, method and
// route template only: the same fields the request log already prints). Always on, one timer, unref'd, no I/O
// unless a stall happened. The registry lives on globalThis: proxy.ts and the pages are bundled apart (lib/store-warm.ts).
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'

const STALL_MS = 2000
const INTERVAL_MS = 500
const RECENT_MAX = 20

type Recent = { id: string; method: string; path: string; at: number }
type State = { recent: Recent[]; installed?: boolean }
const G = globalThis as typeof globalThis & { __dazlLoopStall?: State }
const state = (): State => (G.__dazlLoopStall ??= { recent: [] })

export function noteRecentRequest(id: string, method: string, path: string, at = Date.now()): void {
  const r = state().recent
  r.push({ id, method, path, at })
  if (r.length > RECENT_MAX) r.splice(0, r.length - RECENT_MAX)
}

interface StallLine {
  level: 'warn'; type: 'event_loop_stall'; ts: string; stall_ms: number; max_delay_ms: number | null
  heap_used_mb: number; heap_total_mb: number; rss_mb: number
  recent_requests: { request_id: string; method: string; path: string; started_ms_before_stall_end: number }[]
}

type StallDeps = { stallMs?: number; intervalMs?: number; log?: (line: string) => void; now?: () => number; histogram?: boolean }

// Returns a stop function. Installing twice in one process (two bundles both calling it) keeps the first one.
export function installLoopStallMonitor(deps: StallDeps = {}): () => void {
  const st = state()
  if (st.installed) return () => {}
  st.installed = true
  const stallMs = deps.stallMs ?? STALL_MS, intervalMs = deps.intervalMs ?? INTERVAL_MS
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((l: string) => { try { process.stdout.write(l + '\n') } catch { /* never throws */ } })
  let h: IntervalHistogram | null = null
  if (deps.histogram !== false) { try { h = monitorEventLoopDelay({ resolution: 20 }); h.enable() } catch { h = null } }
  let last = now()
  const timer = setInterval(() => {
    const t = now(), stall = t - last - intervalMs
    last = t
    if (stall <= stallMs) { h?.reset(); return }
    try {
      const m = process.memoryUsage(), mb = (n: number) => Math.round(n / 1048576)
      const from = t - stall - intervalMs
      const line: StallLine = {
        level: 'warn', type: 'event_loop_stall', ts: new Date(t).toISOString(), stall_ms: Math.round(stall),
        max_delay_ms: h ? Math.round(h.max / 1e6) : null,
        heap_used_mb: mb(m.heapUsed), heap_total_mb: mb(m.heapTotal), rss_mb: mb(m.rss),
        recent_requests: state().recent.filter(r => r.at >= from - 5000).map(r => ({ request_id: r.id, method: r.method, path: r.path, started_ms_before_stall_end: t - r.at })),
      }
      log(JSON.stringify(line))
    } catch { /* the monitor never breaks the app */ }
    h?.reset()
  }, intervalMs)
  timer.unref?.()
  return () => { clearInterval(timer); h?.disable(); st.installed = false }
=======
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
>>>>>>> origin/main
}
