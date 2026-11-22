// #1395: the request plan's own rules, unit by unit: the strict schema, grounding of places in the request, the per-play cache, a refused spend
// reservation never swallowed, and the board place built from plan places (the posting side is the existing one; nothing widens).
// The runner-path tests are in request-plan-board-place-1395.test.ts. SYNTHETIC requests and replies, except REAL (a prod matrix request).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePlan, groundedIn, readRequestPlan, cachedRequestPlan, clearRequestPlanCache, type RequestPlan } from '../lib/scan/request-plan.ts'
import { boardPlaceOf } from '../lib/sources/jobboards.ts'
import { ProviderError, type Provider } from '../lib/llm/provider.ts'
import { SpendRefused } from '../lib/llm/spend-guard.ts'

const REAL = 'Dental clinics in Toronto, Ontario that opened a new location or are hiring front-desk staff in the last 90 days'
const plan = (places: RequestPlan['places'], language = 'en'): RequestPlan => ({ offer: null, buyer_type: 'account executive', industry_code: null, places, signals: [{ kind: 'hiring', text: 'hiring', negated: false }], exclusions: [], language })

test('#1395 a model error is a named failure, never a reading', async () => {
  clearRequestPlanCache()
  const failing = { research: async () => ({ text: '', citedUrls: [] }), completeDetailed: async () => { throw new ProviderError('retry', 'http 500', 'uncertain') } } as unknown as Provider
  assert.deepEqual(await readRequestPlan(failing, 'k', REAL, 'T'), { ok: false, reason: 'error' })
})

test('#1395 a valid plan is cached per tenant and request: the same play is read once; another tenant is read again', async () => {
  clearRequestPlanCache()
  let n = 0
  const good = JSON.stringify(plan([{ text: 'Toronto, Ontario', city: 'Toronto', region: 'Ontario', country: 'CA' }]))
  const p = { research: async () => ({ text: '', citedUrls: [] }), completeDetailed: async () => { n++; return { text: good, model: 'm' } } } as unknown as Provider
  assert.equal((await readRequestPlan(p, 'k', REAL, 'T1')).ok, true)
  const again = await readRequestPlan(p, 'k', REAL, 'T1')
  assert.equal(again.ok && again.cached, true)
  await readRequestPlan(p, 'k', REAL, 'T2')
  assert.equal(n, 2)
})

test('#1395 the schema is strict: wrong types, unknown keys, bad codes and oversize lists are refused', () => {
  const ok = plan([{ text: 'Austin, TX', city: 'Austin', region: 'TX', country: 'US' }])
  assert.ok(parsePlan(JSON.stringify(ok)))
  assert.ok(parsePlan('```json\n' + JSON.stringify(ok) + '\n```'), 'one json fence is tolerated')
  for (const bad of [
    { ...ok, language: 'english' }, { ...ok, industry_code: 'fintech' }, { ...ok, places: 'Austin' },
    { ...ok, places: [{ ...ok.places[0], country: 'USA' }] }, { ...ok, places: [{ ...ok.places[0], country: 'ZZ' }] }, { ...ok, places: [{ text: 'Austin' }] },
    { ...ok, signals: [{ kind: 'growth', text: 'x', negated: false }] }, { ...ok, signals: [{ kind: 'hiring', text: 'x', negated: 'no' }] },
    { ...ok, exclusions: Array(11).fill('x') }, Object.fromEntries(Object.entries(ok).filter(([k]) => k !== 'language')),
  ]) assert.equal(parsePlan(JSON.stringify(bad)), null, JSON.stringify(bad).slice(0, 120))
  assert.equal(parsePlan(`Here is the plan: ${JSON.stringify(ok)}`), null, 'prose around the object is refused')
})

test('#1395 grounding: a place must be written in the request; a model country can never move the place the words name', () => {
  const g = (request: string, text: string, city: string | null, region: string | null, country: string | null) => groundedIn(request, { text, city, region, country })
  assert.equal(g('Startups SaaS à Toronto, Canada', 'Toronto, Canada', 'Toronto', null, 'CA'), true)
  assert.equal(g('SaaS-Startups in München, Deutschland', 'München, Deutschland', 'München', null, 'DE'), true, 'a country name in another language the resolver reads')
  assert.equal(g('hiring in Austin, TX', 'Austin, TX', 'Austin', 'TX', 'US'), true, "a US state's country")
  assert.equal(g('Startups in Toronto', 'Toronto, Canada', 'Toronto', null, 'CA'), false, 'text the request does not write is refused')
  assert.equal(g('Startups in Toronto', 'Toronto', 'Montreal', null, 'CA'), false, 'a city outside the place text is refused')
  assert.equal(g('Startups SaaS à Toronto, Canada', 'Toronto, Canada', 'Toronto', null, 'GB'), false, 'a country the text writes must be the plan\'s')
  // the board place comes from the words, read by the existing resolvers: a model's wrong country for "Toronto" changes nothing
  const tor = boardPlaceOf([{ text: 'Toronto', city: 'Toronto', region: null, country: 'GB' }])
  assert.ok('place' in tor && tor.place.ok('Toronto, ON, Canada') && !tor.place.ok('Toronto, UK'), 'Toronto is the listed Canadian city whatever the plan says')
  assert.ok(!('place' in boardPlaceOf([{ text: 'toronto', city: 'toronto', region: null, country: 'CA' }])), 'a city not written as a name is no place (main read none either)')
})

// Council review (sonnet R1): a place must be written in the request as whole words, never inside another word.
test('#1395 grounding is by whole words: "OR" inside "for" and "Rome" inside "chrome" are not places the request writes', async () => {
  assert.equal(groundedIn('companies hiring sales staff for software', { text: 'OR', city: null, region: 'OR', country: null }), false)
  assert.equal(groundedIn('chrome extension startups hiring', { text: 'Rome', city: 'Rome', region: null, country: 'IT' }), false)
  assert.equal(groundedIn('hiring in Portland, OR', { text: 'Portland, OR', city: 'Portland', region: 'OR', country: 'US' }), true, 'a whole-word state code still counts')
  assert.equal(groundedIn('Startups in Toronto', { text: 'Toronto', city: 'Tor', region: null, country: 'CA' }), false, 'a city that is part of a word of the place text is refused')
  clearRequestPlanCache()
  const p = { research: async () => ({ text: '', citedUrls: [] }), completeDetailed: async () => ({ text: JSON.stringify(plan([{ text: 'OR', city: null, region: 'OR', country: 'US' }])), model: 'm' }) } as unknown as Provider
  assert.deepEqual(await readRequestPlan(p, 'k', 'companies hiring sales staff for software', 'T'), { ok: false, reason: 'place_not_in_request' })
})

// Council review (sonnet R2): two places are compared by the place they resolve to, never by name: two Cambridges are two places.
test('#1395 boardPlaceOf: two same-named cities in different countries are several places, never one', () => {
  const r = boardPlaceOf([{ text: 'Cambridge, UK', city: 'Cambridge', region: null, country: 'GB' }, { text: 'Cambridge, Canada', city: 'Cambridge', region: null, country: 'CA' }])
  assert.match((r as { reason?: string }).reason ?? 'one place', /^skipped_no_place:several:/)
  const same = boardPlaceOf([{ text: 'Toronto', city: 'Toronto', region: null, country: 'CA' }, { text: 'Toronto, Canada', city: 'Toronto', region: null, country: 'CA' }])
  assert.ok('place' in same, 'the same place written twice is one place')
})

// Quest: a refused reservation is a named failure (the caller holds only what needed the plan); losing the job still stops the scan.
test('#1395 readRequestPlan: a refused reservation is the reason spend_refused; a lost job still throws', async () => {
  clearRequestPlanCache()
  const refusing = { research: async () => ({ text: '', citedUrls: [] }), completeDetailed: async () => { throw new SpendRefused('over_limit') } } as unknown as Provider
  assert.deepEqual(await readRequestPlan(refusing, 'k', REAL, 'T'), { ok: false, reason: 'spend_refused' })
  const lost = { research: async () => ({ text: '', citedUrls: [] }), completeDetailed: async () => { throw new SpendRefused('ownership_lost') } } as unknown as Provider
  await assert.rejects(readRequestPlan(lost, 'k', REAL, 'T'), (e: unknown) => e instanceof SpendRefused)
})

// Council review (haiku R4/R5): a written region is never dropped (that widens), and a two-letter region inside a city word is not written.
test('#1395 a UK city with its constituent country keeps that region: Manchester, Wales refuses a Manchester, England posting', () => {
  const r = boardPlaceOf([{ text: 'Manchester, Wales', city: 'Manchester', region: 'Wales', country: 'GB' }])
  assert.ok(!('place' in r) || !r.place.ok('Manchester, England, United Kingdom'), 'never the English Manchester')
  const eng = boardPlaceOf([{ text: 'Manchester, England', city: 'Manchester', region: 'England', country: 'GB' }])
  assert.ok('place' in eng && eng.place.ok('Manchester, England, United Kingdom') && eng.place.ok('Manchester, UK'))
  assert.equal(groundedIn('Companies in Berlin hiring sales staff', { text: 'Berlin', city: 'Berlin', region: 'IN', country: null }), false, '"in" inside "Berlin" is not a region')
})

// Council review (opus R1): the built-in places are data too: a bare "London" is the UK's and "NYC" is New York City, as the board source has always
// read them (the resolver's own data, whatever country the plan gives), and a profile in another country never takes a bare shared London.
test('#1395 board place: the built-in London and New York City are read from the words; another country\'s profile never takes the UK London', async () => {
  assert.equal(groundedIn('SDRs hiring in London', { text: 'London', city: 'London', region: null, country: 'GB' }), true)
  for (const country of ['GB', null, 'CA'] as const) {
    const lon = boardPlaceOf([{ text: 'London', city: 'London', region: null, country }])
    assert.ok('place' in lon && lon.place.name === 'London' && lon.place.ok('London, UK') && !lon.place.ok('London, ON'), `plan country ${country}`)
  }
  for (const text of ['NYC', 'Brooklyn']) { const p = boardPlaceOf([{ text, city: text, region: null, country: 'US' }]); assert.ok('place' in p && p.place.name === 'New York City', text) }
  assert.ok(!('place' in boardPlaceOf([{ text: 'London', city: 'London', region: null, country: 'GB' }], { country: 'CA' })), 'a Canadian profile\'s bare London is never the UK London (#1205)')
})

// Council review (opus R5): lowercase words are not cities: "mobile app teams" is not Mobile, AL; "bathroom" holds no Bath.
test('#1395 board place: lowercase words are no place; a word inside another word is not written', () => {
  assert.ok(!('place' in boardPlaceOf([{ text: 'mobile', city: 'Mobile', region: null, country: 'US' }], { country: 'US' })), '"mobile" is not Mobile, AL')
  assert.equal(groundedIn('bathroom fitters hiring', { text: 'Bath', city: 'Bath', region: null, country: 'GB' }), false)
  const t = boardPlaceOf([{ text: 'Toronto', city: 'Toronto', region: null, country: 'CA' }])
  assert.ok('place' in t && t.place.name === 'Toronto')
  const tc = boardPlaceOf([{ text: 'toronto, canada', city: 'toronto', region: null, country: 'CA' }])
  assert.ok('place' in tc && tc.place.ok('Toronto, ON, Canada'), 'a country WRITTEN with the city reads it whatever the case')
})

// Council review (opus R7): a rejected key is not a missing plan: it stops the scan like every other step's auth failure.
test('#1395 readRequestPlan: an auth failure is rethrown, never held as a plan error', async () => {
  clearRequestPlanCache()
  const auth = { research: async () => ({ text: '', citedUrls: [] }), completeDetailed: async () => { throw new ProviderError('auth', 'http 401', 'none') } } as unknown as Provider
  await assert.rejects(readRequestPlan(auth, 'k', REAL, 'T'), (e: unknown) => e instanceof ProviderError && e.kind === 'auth')
})

// Quest (coverage): "in Faro" with the profile's "Faro, Portugal" is the SAME place: the user's own reviewed profile writes its country. A profile
// naming another city (or none) gives nothing: the profile never stands in for a place the request names.
test('#1395 board place: a profile entry naming the same city with its country reads that city; another city never does', () => {
  const faro = { text: 'Faro', city: 'Faro', region: null, country: 'PT' }
  const same = boardPlaceOf([faro], { where: ['Faro, Portugal'] })
  assert.ok('place' in same && same.place.ok('Faro, Portugal') && !same.place.ok('Lisbon, Portugal'))
  assert.ok(!('place' in boardPlaceOf([faro], { where: ['Lisbon, Portugal'] })), 'another city of the profile gives nothing')
  assert.ok(!('place' in boardPlaceOf([faro], {})), 'no profile, no place')
})

// Qodo High (#1527): a region or country WRITTEN in the place text must be in the plan's fields; omitted or conflicting qualifiers are refused,
// never left for a resolver to infer another place ("London, Ontario" with only city London would be the UK London).
test('#1395 grounding: a written region or country the plan omits or contradicts is refused', async () => {
  const req = 'Dental clinics in London, Ontario hiring front-desk staff'
  assert.equal(groundedIn(req, { text: 'London, Ontario', city: 'London', region: null, country: null }), false, 'region and country omitted')
  assert.equal(groundedIn(req, { text: 'London, Ontario', city: 'London', region: null, country: 'GB' }), false, 'region omitted, wrong country')
  assert.equal(groundedIn(req, { text: 'London, Ontario', city: 'London', region: 'Ontario', country: 'CA' }), true)
  assert.equal(groundedIn('Startups SaaS à Toronto, Canada', { text: 'Toronto, Canada', city: 'Toronto', region: null, country: null }), false, 'a written country omitted')
  assert.equal(groundedIn('hiring in Austin, TX', { text: 'Austin, TX', city: 'Austin', region: null, country: 'US' }), false, 'a written state omitted')
  clearRequestPlanCache()
  const p = { research: async () => ({ text: '', citedUrls: [] }), completeDetailed: async () => ({ text: JSON.stringify(plan([{ text: 'London, Ontario', city: 'London', region: null, country: null }])), model: 'm' }) } as unknown as Provider
  assert.deepEqual(await readRequestPlan(p, 'k', req, 'T'), { ok: false, reason: 'place_not_in_request' })
})

// Qodo Medium (#1527), against the REAL guard: a refused reservation latches a SpendGuard (every later reservation is refused, even one with room).
// The optional plan call therefore checks room first and reserves nothing when there is none, so no guard latches and later paid steps go on.
test('#1395 the plan call checks room on the real guards first: no room means no reservation, no latch; a later step still reserves', async () => {
  const { SpendGuard } = await import('../lib/llm/spend-guard.ts')
  const { optionalCallHasRoom } = await import('../lib/scan/runner.ts')
  // what a reservation without the check does: the real guard latches
  const latched = new SpendGuard(0.01, 0.0095)
  assert.throws(() => latched.reserveUsd(0.004), (e: unknown) => e instanceof SpendRefused)
  assert.throws(() => latched.reserveUsd(0.0001), (e: unknown) => e instanceof SpendRefused, 'a latched guard refuses even a step with room')
  // with the check: no room for the plan, nothing reserved, the guard is not latched and a later small step still reserves
  const g = new SpendGuard(0.01, 0.0095)
  assert.equal(await optionalCallHasRoom([g], 0.004), false)
  assert.equal(g.refused, false)
  g.reserveUsd(0.0004)
  assert.ok(Math.abs(g.reservedUsd - 0.0099) < 1e-12)
  assert.equal(await optionalCallHasRoom([new SpendGuard(1)], 0.004), true)
})

// A plan already read for the play is served from the cache with no call, so the runner's room check never refuses it (it reserves nothing).
test('#1395 cachedRequestPlan: a play read once is available without a call; another tenant\'s is not', async () => {
  clearRequestPlanCache()
  const p = { research: async () => ({ text: '', citedUrls: [] }), completeDetailed: async () => ({ text: JSON.stringify(plan([])), model: 'm' }) } as unknown as Provider
  assert.equal(cachedRequestPlan('T', REAL), null)
  await readRequestPlan(p, 'k', REAL, 'T')
  assert.ok(cachedRequestPlan('T', REAL))
  assert.equal(cachedRequestPlan('T2', REAL), null)
})

// Qodo High (#1527, b2742c2): a lowercase written state is still a written qualifier. "Austin, texas" with the plan's region omitted is refused
// (never left for a resolver to infer), and a plan that writes the region is read as the CITY of Austin, never as all of Texas.
// SYNTHETIC request. A two-letter lowercase word ("in", "or", "me") is still never read as a state code.
test('#1395 grounding and board place: "Austin, texas" (lowercase state) is never all of Texas', () => {
  const req = 'B2B SaaS companies hiring account executives in Austin, texas'
  assert.equal(groundedIn(req, { text: 'Austin, texas', city: 'Austin', region: null, country: null }), false, 'an omitted lowercase state is refused')
  assert.equal(groundedIn(req, { text: 'Austin, texas', city: 'Austin', region: 'texas', country: 'US' }), true)
  assert.equal(groundedIn('teams in or near Austin', { text: 'in or near Austin', city: 'Austin', region: null, country: null }), true, 'two-letter words are not state codes')
  const b = boardPlaceOf([{ text: 'Austin, texas', city: 'Austin', region: 'texas', country: 'US' }], { country: 'US' })
  assert.ok('place' in b, `Austin, texas is a place: ${JSON.stringify(b)}`)
  assert.ok(b.place.ok('Austin, TX'), 'an Austin posting is in Austin')
  assert.ok(!b.place.ok('Houston, TX') && !b.place.ok('Dallas, Texas'), 'another Texas city is not Austin')
})

// Qodo High (#1527, b2742c2): a bare request city read through the profile is read only when every profile entry naming that city names ONE place.
// A profile listing Cambridge, Ontario and Cambridge, UK holds the boards, in either order (never the first entry). SYNTHETIC profile.
test('#1395 board place: a bare city matching two different profile places holds, in either order', () => {
  const cam = { text: 'Cambridge', city: 'Cambridge', region: null, country: null }
  for (const where of [['Cambridge, Ontario', 'Cambridge, UK'], ['Cambridge, UK', 'Cambridge, Ontario']]) {
    const r = boardPlaceOf([cam], { where })
    assert.ok('reason' in r && /^skipped_no_place:/.test(r.reason), `${where.join(' | ')}: ${JSON.stringify(r)}`)
  }
  // two entries naming the SAME place are one place
  const one = boardPlaceOf([cam], { where: ['Cambridge, UK', 'Cambridge, United Kingdom'] })
  assert.ok('place' in one && one.place.ok('Cambridge, UK') && !one.place.ok('Cambridge, ON, Canada'), JSON.stringify(one))
})
