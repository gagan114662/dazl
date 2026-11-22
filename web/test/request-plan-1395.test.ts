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

test('#1395 a refused spend reservation is never swallowed as a missing plan: it stops the caller', async () => {
  clearRequestPlanCache()
  const refusing = { research: async () => ({ text: '', citedUrls: [] }), completeDetailed: async () => { throw new SpendRefused('over_limit') } } as unknown as Provider
  await assert.rejects(readRequestPlan(refusing, 'k', REAL, 'T'), (e: unknown) => e instanceof SpendRefused)
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
  assert.equal(g('startups in toronto hiring', 'Toronto', 'Toronto', null, 'CA'), true, 'case differs; the country is implied by the listed world city')
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
