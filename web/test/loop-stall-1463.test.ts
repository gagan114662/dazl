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

test('Qodo #1529: a scan that finished during the blocked window is still named', async () => {
  const { scanStarted, scanEnded, scansDuring } = await import('../lib/ops/loop-stall.ts')
  scanStarted('aaaa1111', 1000); scanStarted('bbbb2222', 1000)
  scanEnded('aaaa1111', 5000)                       // finished inside the window that started at 2000
  scanEnded('bbbb2222', 1500)                       // finished before it: not named
  scanStarted('cccc3333', 9000)                     // started after it: not named
  assert.deepEqual(scansDuring(2000, 8000).sort(), ['aaaa1111'])
  scanStarted('dddd4444', 1000)
  assert.deepEqual(scansDuring(2000, 8000).sort(), ['aaaa1111', 'dddd4444'])
})
