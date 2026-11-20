import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setDayCap, writeEnvAtomically, APPLY_STEP } from '../lib/ops/day-cap.ts'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

// Qodo on #1441 (5): the run env is replaced atomically: a failed write leaves the original whole, no temp file left.
test('the env file is replaced atomically, keeps its mode, and a failed write leaves the original intact', () => {
  const d = mkdtempSync(join(tmpdir(), 'cap-')), f = join(d, 'run.env')
  try {
    writeFileSync(f, 'A=1\n', { mode: 0o640 })
    writeEnvAtomically(f, 'A=2\n')
    assert.equal(readFileSync(f, 'utf8'), 'A=2\n')
    assert.equal(statSync(f).mode & 0o777, 0o640)
    assert.throws(() => writeEnvAtomically(f, 'A=3\n', () => { throw new Error('disk full') }))
    assert.equal(readFileSync(f, 'utf8'), 'A=2\n', 'original intact')
    assert.deepEqual(readdirSync(d).sort(), ['run.env'], 'no temp file left')
  } finally { rmSync(d, { recursive: true, force: true }) }
})
// Qodo on #1441 (1): a restart reloads only the release snapshot; the run env is applied by the deploy that regenerates it.
test('the printed apply step is the deploy that regenerates the release env, never a bare restart', () => {
  assert.match(APPLY_STEP, /deploy-prod\.sh/)
  assert.doesNotMatch(APPLY_STEP, /restart/i)
})
