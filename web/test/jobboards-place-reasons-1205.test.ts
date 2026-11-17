// #1205: the job-board source either runs on the intended place (a posting for another place of the same name is refused), or says in plain
// words why it did not and what to change. The coverage table below is the issue's own table; the strings are the issue's exact strings.
// Pure functions only: no HTTP, no key, no DB.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { placeIn, placeSkipReason, profilePlaceText } from '../lib/sources/jobboards.ts'
import { skipNote, progressOf } from '../lib/scan/progress.ts'

test('#1205 wrong geography: London, Ontario / London, ON / London, Kentucky are not the UK London', () => {
  for (const q of ['Startups in London, Ontario hiring a sales rep', 'in London, ON', 'in London, Kentucky']) {
    const p = placeIn(q)!
    assert.ok(p, q)
    assert.equal(p.ok('London, UK'), false, `${q}: a UK posting is refused`)
    assert.equal(p.ok('London, England, United Kingdom'), false, `${q}: a UK posting is refused`)
  }
  assert.equal(placeIn('in London, Ontario')!.ok('London, Ontario, Canada'), true)
  assert.equal(placeIn('in London, ON')!.ok('London, ON'), true)
  assert.equal(placeIn('in London, ON')!.ok('London, KY'), false, 'London, ON is not London, KY')
  const ky = placeIn('in London, Kentucky')!
  assert.equal(ky.name, 'London, KY')
  assert.equal(ky.ok('London, KY'), true)
  assert.equal(ky.ok('London, ON'), false, 'London, KY is not London, ON')
  // the UK London is unchanged
  const uk = placeIn('London UK B2B SaaS startups hiring sales staff')!
  assert.equal(uk.name, 'London'); assert.equal(uk.ok('London, UK'), true); assert.equal(uk.ok('London, Ontario, Canada'), false)
  assert.equal(placeIn('hiring sales staff in London')!.ok('London, UK'), true, 'a bare London stays the UK London')
})

test('#1205 wrong geography: Cambridge, UK refuses a Cambridge, MA posting', () => {
  const p = placeIn('in Cambridge, UK')!
  assert.equal(p.name, 'Cambridge')
  assert.equal(p.ok('Cambridge, MA'), false)
  assert.equal(p.ok('Cambridge, Massachusetts'), false)
  assert.equal(p.ok('Cambridge, England'), true)
  assert.equal(p.ok('Cambridge'), true)
  assert.equal(placeIn('in Cambridge, MA')!.ok('Cambridge, England'), false, 'and the other way round')
})

test('#1205 coverage table: every shape resolves to the intended place or names why not', () => {
  // [shape, resolves to (place name) | the skip reason prefix]
  const table: [string, string | RegExp][] = [
    ['in Austin, TX', 'Austin, TX'], ['in Springfield, IL', 'Springfield, IL'], ['in Paris, Texas', 'Paris, TX'],
    ['in Texas', 'Texas'],
    ['in London', 'London'], ['in the UK', 'United Kingdom'], ['in New York City', 'New York City'],
    ['in Berlin, Germany', 'Berlin'], ['in Cambridge, UK', 'Cambridge'],
    // non-US city alone / with province: now resolve (bounded city list; Canadian provinces)
    ['in Toronto', 'Toronto'], ['in Berlin', 'Berlin'], ['in Mumbai', 'Mumbai'], ['in Lagos', 'Lagos'], ['in Dubai', 'Dubai'], ['in Sydney', 'Sydney'], ['in São Paulo', 'São Paulo'],
    ['in Toronto, Ontario', 'Toronto'],
    // the rest name a reason
    ['in Germany', /^skipped_no_place:country:Germany$/], ['in Canada', /^skipped_no_place:country:Canada$/], ['in India', /^skipped_no_place:country:India$/], ['in Nigeria', /^skipped_no_place:country:Nigeria$/],
    ['in the United States', /^skipped_no_place:country:/], ['Seed-stage startups in the US', /^skipped_no_place:country:US$/],
    ['in Europe', /^skipped_no_place:region:Europe$/], ['in EMEA', /^skipped_no_place:region:EMEA$/], ['in the Greater Toronto Area', /^skipped_no_place:region:/], ['in the Bay Area', /^skipped_no_place:region:/],
    ['in Ontario', /^skipped_no_place:province:Ontario$/],
    ['in Mumbai or Pune', /^skipped_no_place:several:Mumbai, Pune$/], ['in Dubai or Lagos', /^skipped_no_place:several:Dubai, Lagos$/],
    ['in Springfield', /^skipped_no_place:ambiguous:Springfield$/], ['in Portland', /^skipped_no_place:ambiguous:Portland$/], ['in Cambridge', /^skipped_no_place:ambiguous:Cambridge$/],
    ['B2B SaaS companies hiring sales reps', /^skipped_no_place$/],
  ]
  for (const [q, want] of table) {
    const p = placeIn(q)
    if (typeof want === 'string') assert.equal(p?.name, want, q)
    else { assert.equal(p, null, `${q}: no place`); assert.match(placeSkipReason(`companies ${q} hiring sales`), want, q) }
  }
})

test('#1205 a resolved non-US city refuses a posting for another place of the same name', () => {
  const t = placeIn('in Toronto')!
  assert.equal(t.ok('Toronto, ON, Canada'), true); assert.equal(t.ok('Toronto, Ohio'), false); assert.equal(t.ok('Toronto, OH'), false)
  const s = placeIn('in Sydney')!
  assert.equal(s.ok('Sydney NSW, Australia'), true); assert.equal(s.ok('Sydney, Nova Scotia, Canada'), false)
})

test('#1205 a profile place: a listed city resolves; two places name several; an unknown city names itself', () => {
  assert.equal(profilePlaceText('Toronto', 'CA'), 'Toronto')
  assert.match(placeSkipReason('B2B SaaS hiring sales', ['Toronto', 'Ottawa']), /^skipped_no_place:several:Toronto, Ottawa$/)
  assert.match(placeSkipReason('B2B SaaS hiring sales', ['Kitchener']), /^skipped_no_place:city:Kitchener$/)
})

test('#1205 the progress row words the reason (names the place and what to change), never only "Not used for this search"', () => {
  for (const [raw, words] of [
    ['skipped_no_place:region:Europe', /'Europe' is a region.*city/],
    ['skipped_no_place:country:Canada', /'Canada' is a whole country.*city/],
    ['skipped_no_place:province:Ontario', /'Ontario' is a province.*'Toronto, Ontario'/],
    ['skipped_no_place:ambiguous:Springfield', /'Springfield' could be more than one place.*state or country/],
    ['skipped_no_place:city:Kitchener', /'Kitchener'.*state or country/],
    ['skipped_no_place:several:Dubai, Lagos', /more than one place \(Dubai, Lagos\)/],
    ['skipped_no_place', /No place in the search or your profile/],
  ] as const) assert.match(skipNote(raw)!, words, raw)
  assert.equal(skipNote('skipped_no_hiring_signal'), null)
  const [row] = progressOf([{ collector: 'adapter:jobboards', status: 'skipped_no_place:region:Europe' }], 'done')
  assert.equal(row.status, 'skipped')
  assert.match(row.note ?? '', /'Europe' is a region/)
})

test('#1205 review F1: a bare listed world city is read in the profile\'s country (US Vancouver is Vancouver, WA), never overriding it', () => {
  assert.equal(profilePlaceText('Vancouver', 'US'), 'Vancouver, WA')
  assert.equal(profilePlaceText('Vancouver', 'USA'), 'Vancouver, WA')
  assert.equal(profilePlaceText('Vancouver', 'CA'), 'Vancouver'); assert.equal(profilePlaceText('Vancouver', 'Canada'), 'Vancouver'); assert.equal(profilePlaceText('Vancouver', undefined), 'Vancouver')
  assert.equal(profilePlaceText('Vancouver', 'GB'), null)
  assert.match(placeSkipReason('B2B SaaS hiring sales', ['Vancouver']), /^skipped_no_place:city:Vancouver$/, 'a profile city that cannot be placed names itself')
  assert.equal(placeIn(`B2B SaaS hiring sales in ${profilePlaceText('Vancouver', 'US')}`)!.ok('Vancouver, BC, Canada'), false)
  assert.equal(placeIn(`B2B SaaS hiring sales in ${profilePlaceText('Vancouver', 'US')}`)!.ok('Vancouver, WA'), true)
})

test('#1205 review F2: the run report carries each skipped source\'s named reason', async () => {
  const { buildRunReport } = await import('../lib/scan/run-report.ts')
  const r = buildRunReport({ source_skips: [{ source: 'adapter:jobboards', status: 'skipped_no_place:region:Europe', reason: skipNote('skipped_no_place:region:Europe')! }] }, null, null, 1) as { source_skips?: { reason: string }[] }
  assert.match(r.source_skips?.[0]?.reason ?? '', /'Europe' is a region\. Job postings need a city/)
})
