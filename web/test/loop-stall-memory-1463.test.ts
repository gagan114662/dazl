// #1463 follow-up: a stall line also names the process memory and the requests that started around it, so a stall with no
// scan running still says what was happening. A real busy loop, the real watch (lib/ops/loop-stall.ts), the real request log.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installLoopStallWatch } from '../lib/ops/loop-stall.ts'
import { logRequest, requestLogLine, setRequestLogWriter } from '../lib/ops/request-log.ts'

const busy = (ms: number) => { const t = Date.now(); while (Date.now() - t < ms) { /* a synchronous stretch */ } }
const tick = (ms: number) => new Promise(r => setTimeout(r, ms))

test('#1463: a 2.5 s synchronous block logs one event_loop_stall line with heap, RSS and the request that started just before it', async () => {
  const lines: string[] = []
  const restore = setRequestLogWriter(() => {})
  installLoopStallWatch(l => lines.push(l))
  try {
    await tick(400)
    logRequest(requestLogLine('b6bd2698-f6bd-477d-b778-19ed2b09d9cc', 'GET', '/api/leads/play-research'))
    busy(2500)
    await tick(400)
    const stalls = lines.map(l => JSON.parse(l)).filter(l => l.type === 'event_loop_stall')
    assert.equal(stalls.length, 1, lines.join('\n'))
    const s = stalls[0]
    assert.ok(s.blocked_ms >= 2000 && s.blocked_ms < 4000, String(s.blocked_ms))
    assert.ok(s.heap_used_mb > 0 && s.heap_total_mb >= s.heap_used_mb && s.rss_mb > 0, JSON.stringify(s))
    assert.deepEqual(s.recent_requests.map((r: { request_id: string; path: string }) => [r.request_id, r.path]), [['b6bd2698-f6bd-477d-b778-19ed2b09d9cc', '/api/leads/play-research']])
  } finally { restore() }
})
