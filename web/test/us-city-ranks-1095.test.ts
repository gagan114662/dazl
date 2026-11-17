// #1095 review (xhawk at cdfdb41f): the city-rank table must not hand a bare name to an unrelated municipality, and its generator must run.
// Data: the checked-in table (generated from US Census Vintage 2022, public domain). No network, no key.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { bareUsCity } from '../lib/sources/jobboards.ts'
import { US_CITY_RANKS } from '../lib/sources/us-city-ranks.ts'

test('an ordinary hyphenated city is not aliased to its first or last part', () => {
  assert.equal(US_CITY_RANKS.find(r => r.startsWith('Winston|NC|')), undefined)
  assert.equal(US_CITY_RANKS.find(r => r.startsWith('Barre|PA|')), undefined)
  assert.equal(bareUsCity('Winston'), null)
  assert.ok(US_CITY_RANKS.some(r => r.startsWith('Winston-Salem|NC|')))
  assert.ok(US_CITY_RANKS.some(r => r.startsWith('Wilkes-Barre|PA|')))
})

test('consolidated cities keep their well-known short name', () => {
  assert.deepEqual(bareUsCity('Nashville'), { city: 'Nashville', abbr: 'TN' })
  assert.deepEqual(bareUsCity('Boise'), { city: 'Boise', abbr: 'ID' })
  assert.deepEqual(bareUsCity('Macon'), { city: 'Macon', abbr: 'GA' })
  assert.deepEqual(bareUsCity('Lexington'), { city: 'Lexington', abbr: 'KY' })
  assert.ok(!US_CITY_RANKS.some(r => /^[^|]*County[^|]*\|/.test(r) && /^(Bibb|Clarke|Richmond|Jefferson) County\|/.test(r)), 'a county is never a city alias')
})

// #1236: only the FIRST part of a consolidated name is its city alias; a county-name part ("Davidson", "Silver Bow") is never one.
test('a consolidated city county-name part is not a city alias (#1236)', () => {
  assert.equal(US_CITY_RANKS.find(r => r.startsWith('Davidson|TN|')), undefined)
  assert.equal(US_CITY_RANKS.find(r => r.startsWith('Silver Bow|MT|')), undefined)
  assert.notDeepEqual(bareUsCity('Davidson'), { city: 'Davidson', abbr: 'TN' })
  assert.deepEqual(bareUsCity('Davidson'), { city: 'Davidson', abbr: 'NC' })   // the real incorporated place now wins
  assert.equal(bareUsCity('Silver Bow'), null)
  for (const [c, st] of [['Nashville', 'TN'], ['Louisville', 'KY'], ['Lexington', 'KY'], ['Macon', 'GA'], ['Athens', 'GA'], ['Augusta', 'GA'], ['Butte', 'MT'], ['Hartsville', 'TN'], ['Boise', 'ID']])
    assert.ok(US_CITY_RANKS.some(r => r.startsWith(`${c}|${st}|`)), `${c}, ${st} still resolves`)
})

test('the generator imports no module the documented redirect truncates', () => {
  const g = readFileSync(new URL('../scripts/gen-us-city-ranks.mts', import.meta.url), 'utf8')
  assert.ok(!/from '\.\.\/lib\/sources\/(jobboards|us-city-ranks)\.ts'/.test(g))
  assert.match(g, /from '\.\.\/lib\/sources\/us-states\.ts'/)
})
