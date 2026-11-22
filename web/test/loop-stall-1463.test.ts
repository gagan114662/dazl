import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loopStallLine, LOOP_STALL_MS } from '../lib/ops/loop-stall.ts'

// #1463: on prod 383ada0a a reload sat ~24s with no request while a scan ran in the same process, then everything answered in <100ms.
// Pages and scans share one event loop; a long synchronous stretch blocks every render and no timer (stall watch, session deadline)
// can fire. The server now says so in the journal: how long the loop was blocked and which scans were running.
test('a blocked event loop past the threshold is logged with the running scans; short gaps are not', () => {
  assert.equal(loopStallLine(LOOP_STALL_MS - 1, []), null)
  const l = JSON.parse(loopStallLine(24300, ['aa193734']) ?? '{}')
  assert.deepEqual(l, { level: 'warn', type: 'event_loop_stall', blocked_ms: 24300, scans: ['aa193734'] })
})
