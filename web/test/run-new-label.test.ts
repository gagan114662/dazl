import test from 'node:test'
import assert from 'node:assert/strict'
import { runNewLabel } from '../lib/run-new-label.ts'

test('a monitor run count reads as alerts, a watch run count keeps "new" (different meanings, #387)', () => {
  assert.equal(runNewLabel('monitor', 2), '2 new alerts')
  assert.equal(runNewLabel('monitor', 0), '0 new alerts')
  assert.equal(runNewLabel('watch', 3), '3 new')
})
