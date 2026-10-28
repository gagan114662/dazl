import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BOUNDARY_COPY } from '../lib/error-boundary-copy.ts'

// Instinct #240: the boundary has no receipt of what an action did, so it must never promise "no effect".
test('error boundary copy never claims an action had no effect, and asks to check before repeating', () => {
  for (const c of Object.values(BOUNDARY_COPY)) {
    const all = `${c.title} ${c.body}`
    assert.doesNotMatch(all, /nothing (was|is|has been) (sent|changed|affected)|not affected|no effect|nothing you approved/i)
    assert.match(c.body, /check its result .*before doing it again/i)
  }
})
