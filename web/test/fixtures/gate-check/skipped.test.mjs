// Fixture for test/gate-check.test.ts only. Never run by npm test or by the real gate (fixtures/ is not scanned).
import { test } from 'node:test'
import assert from 'node:assert/strict'
test.skip('#4204 skipped', () => { assert.fail('never runs') })
test('#4204 todo', { todo: true }, () => {})
