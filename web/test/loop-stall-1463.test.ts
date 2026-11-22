// #1463: a blocked event loop must name itself in the log (lib/ops/loop-stall.ts). A real busy loop, the real timer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installLoopStallMonitor, noteRecentRequest } from '../lib/ops/loop-stall.ts'
import { logRequest, requestLogLine, setRequestLogWriter } from '../lib/ops/request-log.ts'

const busy = (ms: number) => { const t = Date.now(); while (Date.now() - t < ms) { /* blocks the loop, as a sync step would */ } }
const tick = (ms: number) => new Promise(r => setTimeout(r, ms))

test('#1463: a 2.5 s synchronous block writes one event_loop_stall line with its duration, memory and the request that started it', async () => {
  const lines: string[] = []
  const restore = setRequestLogWriter(() => {})
  const stop = installLoopStallMonitor({ stallMs: 1000, intervalMs: 100, log: l => lines.push(l) })
  try {
    await tick(250)
    logRequest(requestLogLine('b6bd2698-f6bd-477d-b778-19ed2b09d9cc', 'GET', '/api/leads/play-research'))
    busy(2500)
    await tick(300)
    const stalls = lines.map(l => JSON.parse(l)).filter(l => l.type === 'event_loop_stall')
    assert.equal(stalls.length, 1, lines.join('\n'))
    const s = stalls[0]
    assert.ok(s.stall_ms >= 2000 && s.stall_ms < 4000, String(s.stall_ms))
    assert.ok(s.heap_used_mb > 0 && s.heap_total_mb >= s.heap_used_mb && s.rss_mb > 0)
    assert.deepEqual(s.recent_requests.map((r: { request_id: string; path: string }) => [r.request_id, r.path]), [['b6bd2698-f6bd-477d-b778-19ed2b09d9cc', '/api/leads/play-research']])
  } finally { stop(); restore() }
})

test('#1463: a quiet loop and short pauses write nothing; a second install in the same process is a no-op', async () => {
  const lines: string[] = []
  const stop = installLoopStallMonitor({ stallMs: 1000, intervalMs: 100, log: l => lines.push(l) })
  const again: string[] = []
  const stop2 = installLoopStallMonitor({ stallMs: 1, intervalMs: 10, log: l => again.push(l) })
  try {
    await tick(300); busy(400); await tick(300)
    noteRecentRequest('x', 'GET', '/api/leads')
    assert.deepEqual(lines, []); assert.deepEqual(again, [], 'only one monitor per process')
  } finally { stop2(); stop() }
})

test('#1463: the app installs the monitor at startup (instrumentation register)', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../instrumentation.ts', import.meta.url), 'utf8')
  assert.match(src, /installLoopStallMonitor\(\)/)
})
