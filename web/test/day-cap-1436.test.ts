import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setDayCap } from '../lib/ops/day-cap.ts'
import { windowCap } from '../lib/llm/spend-pool.ts'

test('sets one workspace day cap, keeps every other entry and setting, and the cap reader sees it', () => {
  const env = 'A=1\nDAZL_RUN_MAX_USD_USERS=other:3,ws1:2.40\nB=2\n'
  const r = setDayCap(env, 'ws1', '5')
  assert.equal(r.text, 'A=1\nDAZL_RUN_MAX_USD_USERS=other:3,ws1:5\nB=2\n')
  assert.equal(r.before, 'ws1:2.40')
  const line = r.text.split('\n')[1].split('=')[1]
  assert.deepEqual(windowCap('day', 'ws1', { DAZL_RUN_MAX_USD_USERS: line }).usd, 5)
  assert.deepEqual(windowCap('day', 'other', { DAZL_RUN_MAX_USD_USERS: line }).usd, 3)
})
test('adds the line when missing; refuses bad ids, non-numbers, zero and amounts above the ceiling', () => {
  assert.equal(setDayCap('A=1\n', 'ws1', '5').text, 'A=1\nDAZL_RUN_MAX_USD_USERS=ws1:5\n')
  for (const [t, u] of [['ws 1', '5'], ['ws1', '0'], ['ws1', '-1'], ['ws1', 'five'], ['ws1', '1e3'], ['ws1', '101']]) assert.throws(() => setDayCap('', t, u), `${t} ${u}`)
})
