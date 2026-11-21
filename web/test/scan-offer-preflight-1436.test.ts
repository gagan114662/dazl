// The Leads chooser's decisions, through the real client helpers it imports (app/app/leads/offer-preflight.ts). No
// source is compiled or evaluated at test time. The estimate/scan 409 itself is covered on the real route handlers
// (test/helpers/estimate-route-runtime.mts, play-offer-route-runtime.mts); the rendered flow in test/ui/reuse-profile.ui.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { scanOfferConflict, directOfferProfile } from '../app/app/leads/offer-preflight.ts'

const stale = { summary: 'Independent dental practice owners', who: ['Practice owner'], where: ['New York City'], industries: ['Dental'] }
const saved = 'Dental appointment reminder software', stated = 'Leadly (leadly.example)'

test('an estimate 409 offer_conflict becomes the "Use:" choice before any cost panel; anything else is not a choice', () => {
  assert.deepEqual(scanOfferConflict(409, { error: 'offer_conflict', stated, saved }), { stated, saved, ambiguous: false })
  assert.equal(scanOfferConflict(200, { estimate: { ack: 'a' } }), null)
  assert.equal(scanOfferConflict(409, { error: 'estimate_changed' }), null)
  assert.equal(scanOfferConflict(409, { error: 'offer_conflict', stated: 5, saved }), null)
})
test('choosing the stated offer drops the stale saved buyer; keeping the saved offer carries it; a fresh target never does', () => {
  assert.equal(directOfferProfile(stated, saved, stale), null)
  assert.equal(directOfferProfile(saved, saved, stale), stale)
  assert.equal(directOfferProfile(saved, saved, stale, true), null)
  assert.match(stale.summary, /dental/, 'saved/history data is not edited')
})
test('an ambiguous request without a saved offer stays a manual choice', () => {
  assert.deepEqual(scanOfferConflict(409, { error: 'offer_conflict', stated: null, saved: '', ambiguous: true }), { stated: null, saved: '', ambiguous: true })
  assert.equal(scanOfferConflict(409, { error: 'offer_conflict', stated: null, saved: '' }), null)
})

// Qodo on #1441 (folded #1440, finding 1): an offer the routes refuse (cut inside a parenthesis, too short) never enables
// "Run scan with this profile", and the estimate's 400 shows its own words, never a dead-end "Try again".
test('the reviewed Run button needs a complete offer, and a refused offer gets its own message', async () => {
  const { offerReady, estimateFailureCopy } = await import('../app/app/leads/offer-preflight.ts')
  assert.equal(offerReady('Leadly (the AI'), false)
  assert.equal(offerReady('ab'), false)
  assert.equal(offerReady('Leadly (leadly.example), AI lead finding'), true)
  assert.equal(estimateFailureCopy(400, { error: 'Say in a few words what you sell for this play' }), 'Say in a few words what you sell for this play')
  assert.match(estimateFailureCopy(400, { detail: 'bad budget' }), /spend limit was not accepted: bad budget/)
  assert.match(estimateFailureCopy(500, {}), /Try again/)
})
