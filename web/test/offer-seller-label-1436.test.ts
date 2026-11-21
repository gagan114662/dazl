// #1436 follow-up (live check on prod 70671839): a request that names its own seller with a "seller = ..." or
// "Seller: ..." line, beside a saved profile for a different offer, must stop for a choice. Before this it stated no
// offer, so the run went straight to the cost panel on the saved (unrelated) profile. Synthetic names only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effectiveOffer, statedOffer } from '../lib/scan/play-offer-text.ts'
import { playName } from '../lib/play-card.ts'

const SAVED = 'We sell appointment booking and reminder software to independent dental practices in New York City.'
const REQ = 'B2B companies with 5-200 employees doing outbound sales with a dated buying signal (hiring their first SDR or sales rep, new funding, new sales leader, or a founder still doing sales); buyer = Founder, CEO or Head of Sales; seller = Leadly (leadly.example), AI lead finding plus reviewed outreach for any business.'
const OFFER = 'Leadly (leadly.example), AI lead finding plus reviewed outreach for any business'

test('a "seller = ..." line is the request\'s offer, whole, brand and domain kept', () => {
  assert.equal(statedOffer(REQ), OFFER)
  assert.equal(statedOffer('Find founders hiring SDRs. Seller: Leadly (leadly.example), AI lead finding.'), 'Leadly (leadly.example), AI lead finding')
  assert.equal(statedOffer('Find founders; sells = reviewed outreach'), 'reviewed outreach')
})

test('beside a saved dental profile, the seller line is a conflict to choose, never the dental offer', () => {
  assert.deepEqual(effectiveOffer({ query: REQ }, SAVED), { offer: null, source: 'conflict', conflict: { stated: OFFER, recorded: SAVED } })
})

test('a buyer line or a target that mentions sellers is not an offer', () => {
  assert.equal(statedOffer('Find marketplace sellers in Toronto; buyer = Founder'), null)
  assert.equal(statedOffer('Exclude sellers of used cars.'), null)
})

test('a play name never ends inside an unclosed parenthesis', () => {
  const name = playName('Leads for Leadly (the AI lead finder for small teams) today', null)
  assert.equal((name.match(/\(/g) ?? []).length, (name.match(/\)/g) ?? []).length, name)
  assert.doesNotMatch(name, /\([^)]*$/, name)
  assert.equal(playName('Leads for Leadly (leadly.example) now', null), 'Leads for Leadly (leadly.example) now')
})
