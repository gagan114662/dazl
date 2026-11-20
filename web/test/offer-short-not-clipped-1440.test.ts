// #1440 CI (qualify-preview 3 red): a seller/profile text under 3 characters keeps the behavior on main, never an "incomplete" hold.
// A genuinely clipped offer (cut inside a parenthesis) still holds.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effectiveOffer } from '../lib/scan/play-offer-text.ts'

test('a short profile is used as before (no hold); a clipped one is still held', () => {
  assert.deepEqual(effectiveOffer({ offer: null, seller: null, query: 'B2B companies hiring sales roles' }, 'x'), { offer: 'x', source: 'profile', conflict: null })
  assert.deepEqual(effectiveOffer({ offer: 'ab', seller: null, query: 'B2B companies hiring sales roles' }, 'Sales prospecting software'), { offer: 'Sales prospecting software', source: 'profile', conflict: null })
  assert.equal(effectiveOffer({ offer: null, seller: null, query: 'B2B companies hiring sales roles' }, 'Leadly (the AI').conflict?.incomplete, true)
})
