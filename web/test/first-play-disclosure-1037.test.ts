// #1037 live check (Hermes-PC, staging 223b3a4b): a first play DOES run capped TinyFish people searches after the scan, but the
// estimate said "Free sources only ... No TinyFish search or fetch in this mode" and the run-budget note said "no ... post-scan
// people search". The cost panel must state the capped people searches the run will really make.
import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateRun } from '../lib/scan/price-estimate.ts'
import { describeRunBudget } from '../lib/scan/run-budget.ts'
import { FIRST_PLAY_MAX } from '../lib/people/first-play-cap.ts'
import { FIRST_PLAY_MAX as FROM_PEOPLE_SEARCH, firstPlayPeopleCap } from '../lib/people/people-search.ts'

const FIRST5 = { first5: true, paid_fallback: false, credit_enrichment: false }
const row = (e: ReturnType<typeof estimateRun>, id: string) => e.rows.find(r => r.id === id)

test('#1037 first-play estimate lists the capped people searches, never "no TinyFish search"', () => {
  const e = estimateRun({ budget: FIRST5, payer: 'trial', firstPlayPeopleSearches: 10 })
  const p = row(e, 'people_search')
  assert.ok(p, 'a people-search row is shown')
  assert.equal(p!.provider, 'TinyFish'); assert.deepEqual(p!.units, { min: 0, max: 10 })
  assert.match(p!.note ?? '', /at most 10 searches, one per ready lead that names nobody yet/)
  assert.ok(!e.rows.some(r => /No TinyFish search or fetch/.test(r.note ?? '')), 'the false "no TinyFish" line is gone')
  assert.ok(!e.rows.some(r => /Free sources only/.test(r.label)))
  assert.equal(row(e, 'sources_free')!.note, 'No TinyFish lead search or page fetch in this mode')
  assert.ok(!e.rows.some(r => r.id === 'tinyfish_search'), 'no lead search row')
})

test('#1037 first-play people searches are priced when the operator pays per search, and gone when the step is off', () => {
  const priced = estimateRun({ budget: FIRST5, payer: 'trial', firstPlayPeopleSearches: 4, env: { DAZL_PRICE_TINYFISH_SEARCH_USD: '0.01' } })
  assert.deepEqual(row(priced, 'people_search')!.usd, { min: 0, max: 0.04 })
  const off = estimateRun({ budget: FIRST5, payer: 'trial', firstPlayPeopleSearches: 0 })
  assert.equal(row(off, 'people_search'), undefined, 'DAZL_FIRST_PLAY_PEOPLE_SEARCHES=0 or people search off: no row')
  const unknown = estimateRun({ budget: FIRST5, payer: 'trial' })
  assert.deepEqual(row(unknown, 'people_search')!.units, { min: 0, max: FIRST_PLAY_MAX }, 'not passed: the code maximum, never understated')
  assert.deepEqual(row(estimateRun({ budget: FIRST5, payer: 'trial', firstPlayPeopleSearches: 999 }), 'people_search')!.units.max, FIRST_PLAY_MAX)
})

test('#1037 a free-trial (non-first5) scan counts the first-play people cap, not the ordinary 5', () => {
  const t = estimateRun({ budget: null, payer: 'trial', firstPlayPeopleSearches: 10 })
  assert.match(row(t, 'tinyfish_search')!.note ?? '', /plus 10 people searches/)
  const own = estimateRun({ budget: null, payer: 'you', firstPlayPeopleSearches: 10 })
  assert.match(row(own, 'tinyfish_search')!.note ?? '', /plus 5 people searches/, 'an own-key scan keeps the ordinary people cap')
})

test('#1037 run-budget disclosure for first5 states the people searches', () => {
  const d = describeRunBudget(FIRST5)
  const s = d.surfaces.find(x => x.surface === 'search_and_fetch')!
  assert.notEqual(s.status, 'off', 'TinyFish is not off on a first play: the people step uses it')
  assert.match(s.note, /up to 10 TinyFish people searches \(one per ready lead that names nobody yet\)/)
  assert.doesNotMatch(s.note, /no TinyFish search, fetch or post-scan people search/)
})

test('#1037 the cap module is the one people-search uses', () => {
  assert.equal(FROM_PEOPLE_SEARCH, FIRST_PLAY_MAX)
  assert.equal(firstPlayPeopleCap({ DAZL_FIRST_PLAY_PEOPLE_SEARCHES: '3' }), 3)
})
