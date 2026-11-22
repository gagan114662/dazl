// #1395: the request plan's own rules, unit by unit: the strict schema, grounding of places in the request, the per-play cache, a refused spend
// reservation never swallowed, and the board place built from plan places (the posting side is the existing one; nothing widens).
// The runner-path tests are in request-plan-board-place-1395.test.ts. SYNTHETIC requests and replies, except REAL (a prod matrix request).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePlan, groundedIn, readRequestPlan, clearRequestPlanCache, type RequestPlan } from '../lib/scan/request-plan.ts'
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

test('#1395 grounding: a place must be written in the request; its country written there or implied by data', () => {
  const g = (request: string, text: string, city: string | null, region: string | null, country: string | null) => groundedIn(request, { text, city, region, country })
  assert.equal(g('Startups SaaS à Toronto, Canada', 'Toronto, Canada', 'Toronto', null, 'CA'), true)
  assert.equal(g('SaaS-Startups in München, Deutschland', 'München, Deutschland', 'München', null, 'DE'), true, 'a country name in another language the resolver reads')
  assert.equal(g('startups in Toronto hiring', 'Toronto', 'Toronto', null, 'CA'), true, 'the country is implied by the listed world city')
  assert.equal(g('startups in toronto hiring', 'toronto', 'toronto', null, 'CA'), false, 'a city not written as a name implies no country (main read none either)')
  assert.equal(g('hiring in Austin, TX', 'Austin, TX', 'Austin', 'TX', 'US'), true, "a US state's country")
  assert.equal(g('Startups in Toronto', 'Toronto', 'Toronto', null, 'GB'), false, 'a country neither written nor implied is refused')
  assert.equal(g('Startups in Toronto', 'Toronto, Canada', 'Toronto', null, 'CA'), false, 'text the request does not write is refused')
  assert.equal(g('Startups in Toronto', 'Toronto', 'Montreal', null, 'CA'), false, 'a city outside the place text is refused')
})

test('#1395 boardPlaceOf: the posting side is the existing one; several places, unreadable regions and bare countries never widen', () => {
  const one = (p: { text: string; city: string | null; region: string | null; country: string | null }) => boardPlaceOf([p])
  const ca = one({ text: 'California', city: null, region: 'California', country: 'US' })
  assert.ok('place' in ca && ca.place.ok('Los Angeles, CA') && ca.place.ok('San Francisco, California') && !ca.place.ok('Austin, TX'))
  const tor = one({ text: 'Toronto, Ontario', city: 'Toronto', region: 'Ontario', country: 'CA' })
  assert.ok('place' in tor && tor.place.ok('Toronto, ON, Canada') && !tor.place.ok('Vancouver, BC, Canada') && !tor.place.ok('Toronto, OH'))
  const lon = one({ text: 'London, Ontario', city: 'London', region: 'Ontario', country: 'CA' })
  assert.ok('place' in lon && lon.place.ok('London, ON') && !lon.place.ok('London, UK') && !lon.place.ok('Greater London'), 'London, Ontario is never the UK London')
  const uk = one({ text: 'London', city: 'London', region: null, country: 'GB' })
  assert.ok('place' in uk && uk.place.ok('London, UK') && !uk.place.ok('London, ON'))
  const nyc = one({ text: 'NYC', city: 'NYC', region: null, country: 'US' })
  assert.ok('place' in nyc && nyc.place.name === 'New York City')
  const aus = one({ text: 'Austin', city: 'Austin', region: null, country: 'US' })
  assert.ok('place' in aus && aus.place.name === 'Austin, TX', 'a bare US city by the census list')
  assert.deepEqual(boardPlaceOf([]), { reason: 'skipped_no_place' })
  assert.match((boardPlaceOf([{ text: 'Dubai', city: 'Dubai', region: null, country: 'AE' }, { text: 'Lagos', city: 'Lagos', region: null, country: 'NG' }]) as { reason: string }).reason, /^skipped_no_place:several:/)
  assert.match((one({ text: 'Canada', city: null, region: null, country: 'CA' }) as { reason: string }).reason, /^skipped_no_place:country:Canada/)
  assert.match((one({ text: 'Bayern', city: null, region: 'Bayern', country: 'DE' }) as { reason: string }).reason, /^skipped_no_place:region:/)
  assert.match((one({ text: 'Springfield', city: 'Springfield', region: null, country: 'US' }) as { reason: string }).reason, /^skipped_no_place:ambiguous:/)
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
// read them; the model's country for them is grounded, and a null country is filled from the same data.
test('#1395 grounding: the built-in London (GB) and New York City (US) imply their country; a bare London with no country is the UK London', async () => {
  assert.equal(groundedIn('SDRs hiring in London', { text: 'London', city: 'London', region: null, country: 'GB' }), true)
  assert.equal(groundedIn('hiring in NYC', { text: 'NYC', city: 'NYC', region: null, country: 'US' }), true)
  assert.equal(groundedIn('hiring in Brooklyn', { text: 'Brooklyn', city: 'Brooklyn', region: null, country: 'US' }), true)
  assert.equal(groundedIn('SDRs hiring in London', { text: 'London', city: 'London', region: null, country: 'CA' }), false, 'London alone is never another London')
  const lon = boardPlaceOf([{ text: 'London', city: 'London', region: null, country: null }])
  assert.ok('place' in lon && lon.place.name === 'London' && lon.place.ok('London, UK') && !lon.place.ok('London, ON'))
})

// Council review (opus R5): a country implied by data (not written) needs the city written as a name: "mobile app teams" is not Mobile, AL.
test('#1395 grounding: an implied country needs the city written as a name; lowercase words are not cities', () => {
  assert.equal(groundedIn('mobile app teams hiring', { text: 'mobile', city: 'Mobile', region: null, country: 'US' }), false)
  assert.equal(groundedIn('bathroom fitters hiring', { text: 'Bath', city: 'Bath', region: null, country: 'GB' }), false)
  assert.equal(groundedIn('Startups SaaS à Toronto qui recrutent', { text: 'Toronto', city: 'Toronto', region: null, country: 'CA' }), true)
  assert.equal(groundedIn('dentists in toronto, canada', { text: 'toronto, canada', city: 'toronto', region: null, country: 'CA' }), true, 'a country WRITTEN in the request is grounded whatever the case')
})

// Council review (opus R7): a rejected key is not a missing plan: it stops the scan like every other step's auth failure.
test('#1395 readRequestPlan: an auth failure is rethrown, never held as a plan error', async () => {
  clearRequestPlanCache()
  const auth = { research: async () => ({ text: '', citedUrls: [] }), completeDetailed: async () => { throw new ProviderError('auth', 'http 401', 'none') } } as unknown as Provider
  await assert.rejects(readRequestPlan(auth, 'k', REAL, 'T'), (e: unknown) => e instanceof ProviderError && e.kind === 'auth')
})

// Quest (coverage): "in Faro" with the profile's "Faro, Portugal" is the SAME place: the user's own reviewed profile writes its country. A profile
// naming another city (or none) implies nothing: the profile never stands in for a place the request names.
test('#1395 grounding: a profile entry naming the same city with its country grounds that country; another city never does', async () => {
  const faro = { text: 'Faro', city: 'Faro', region: null, country: 'PT' }
  assert.equal(groundedIn('Find employers hiring refrigeration technicians in Faro', faro, ['Faro, Portugal']), true)
  assert.equal(groundedIn('Find employers hiring refrigeration technicians in Faro', faro, ['Lisbon, Portugal']), false, 'another city of the profile implies nothing')
  assert.equal(groundedIn('Find employers hiring refrigeration technicians in Faro', faro, []), false, 'no profile, no implied country')
  assert.equal(groundedIn('Find employers hiring refrigeration technicians in Faro', { ...faro, country: 'ES' }, ['Faro, Portugal']), false, 'only the country the profile writes')
  assert.equal(groundedIn('hiring in faro', { ...faro, text: 'faro', city: 'faro' }, ['Faro, Portugal']), false, 'the city written as a name, as for every implied country')
  clearRequestPlanCache()
  const reply = JSON.stringify(plan([faro]))
  const p = { research: async () => ({ text: '', citedUrls: [] }), completeDetailed: async () => ({ text: reply, model: 'm' }) } as unknown as Provider
  assert.equal((await readRequestPlan(p, 'k', 'Find employers hiring refrigeration technicians in Faro', 'T', undefined, ['Faro, Portugal'])).ok, true)
  assert.deepEqual(await readRequestPlan(p, 'k', 'Find employers hiring refrigeration technicians in Faro', 'T', undefined, []), { ok: false, reason: 'place_not_in_request' }, 'the cache is per profile too')
})
