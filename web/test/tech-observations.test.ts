// #389: technographics as discovery filter and change signal. Synthetic HTML; no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { observe, observable, changeFor, snapshotOf, matchesFilter, techQueries, techLabel, recordObservations, loadObservations, type Fetched } from '../lib/signals/tech-observations.ts'

const DAY = 86400, T0 = 1_790_000_000
const page = (inner: string, pad = 'Harbor Dental offers family dentistry, orthodontics and cosmetic care for patients across the neighbourhood. '.repeat(6)) => `<html><head><title>Harbor</title>${inner}</head><body><h1>Harbor Dental</h1><p>${pad}</p></body></html>`
const fetched = (html: string | null, o: Partial<Fetched> = {}): Fetched => ({ url: 'https://harbor.example/', status: 200, html, ...o })
const SHOP = '<script src="https://cdn.shopify.com/s/x.js"></script>', HUB = '<script src="https://js.hs-scripts.net/1.js"></script>'

test('an inaccessible, blocked, empty or script-only page records NO observation (no absence claim)', () => {
  for (const [f, why] of [[fetched(null, { status: 503 }), 'fetch_failed'], [fetched(page(''), { blocked: true }), 'blocked'], [fetched('<html></html>'), 'empty'], [fetched('<html><body><div id="root"></div>' + '<script>x</script>'.repeat(40) + '</body></html>'), 'js_shell'], [fetched('plain text '.repeat(100)), 'not_html']] as [Fetched, string][]) {
    const r = observe('harbor.example', f, ['Shopify', 'HubSpot'], T0); assert.deepEqual(r.observations, [], why); assert.equal(r.unobservable?.why, why)
  }
})

test('present needs a signature match; absence is only "absent_in_scope" for tracked technologies on an observable page', () => {
  const r = observe('www.harbor.example', fetched(page(SHOP)), ['Shopify', 'HubSpot'], T0)
  const by = Object.fromEntries(r.observations.map(o => [o.tech, o]))
  assert.equal(by.Shopify.state, 'present'); assert.match(by.Shopify.matched!, /shopify/i); assert.equal(by.HubSpot.state, 'absent_in_scope'); assert.ok(by.HubSpot.confidence < by.Shopify.confidence)
  assert.equal(by.Shopify.domain, 'harbor.example'); assert.equal(by.Shopify.page_kind, 'home'); assert.ok(!('Intercom' in by), 'untracked technology is never claimed absent')
})

test('adoption and confirmed removal need comparable dated observations; one absence is unconfirmed; a different page/version is not comparable', () => {
  const o = (state: 'present' | 'absent_in_scope', t: number, over: object = {}) => ({ ...observe('harbor.example', fetched(page(state === 'present' ? HUB : '')), ['HubSpot'], t).observations.find(x => x.tech === 'HubSpot')!, ...over })
  assert.equal(changeFor([o('absent_in_scope', T0), o('present', T0 + 30 * DAY)]).kind, 'adopted')
  assert.equal(changeFor([o('present', T0), o('absent_in_scope', T0 + 30 * DAY)]).kind, 'unconfirmed')
  const rem = changeFor([o('present', T0), o('absent_in_scope', T0 + 30 * DAY), o('absent_in_scope', T0 + 60 * DAY)]); assert.equal(rem.kind, 'removed')
  if (rem.kind === 'removed') { assert.equal(rem.from.state, 'present'); assert.ok(rem.to.observed_at > rem.from.observed_at) }
  assert.equal(changeFor([o('present', T0), o('absent_in_scope', T0 + DAY, { page_url: 'https://harbor.example/blog', page_kind: 'other' })]).kind, 'not_comparable')
  assert.equal(changeFor([o('present', T0), o('absent_in_scope', T0 + DAY, { detector_version: 2 })]).kind, 'not_comparable')
  assert.equal(changeFor([o('present', T0)]).kind, 'none')
})

test('an analytics-script outage or failed fetch cannot imply a migration', () => {
  const ga = '<script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>'
  const good = observe('harbor.example', fetched(page(ga)), ['Google Analytics'], T0).observations
  const outage = observe('harbor.example', fetched(null, { status: 502 }), ['Google Analytics'], T0 + 30 * DAY)
  assert.deepEqual(outage.observations, [])
  const s = snapshotOf(good); assert.equal(s.changes.get('google analytics')!.kind, 'none')
  assert.equal(matchesFilter(s, { migratedFrom: 'Google Analytics' }).match, 'unknown')
})

test('filters are three-valued: unknown never matches; "not uses" needs an observed absence and says it is not proof', () => {
  const snap = snapshotOf(observe('harbor.example', fetched(page(SHOP)), ['HubSpot'], T0).observations)
  const yes = matchesFilter(snap, { uses: ['Shopify'], notUses: ['HubSpot'] }); assert.equal(yes.match, 'yes'); assert.ok(yes.reasons.some(r => /not proof of non-use/.test(r)))
  assert.equal(matchesFilter(snap, { uses: ['Shopify'], notUses: ['Intercom'] }).match, 'unknown')
  assert.equal(matchesFilter(snap, { uses: ['HubSpot'] }).match, 'no'); assert.equal(matchesFilter(snap, { uses: ['Webflow'] }).match, 'unknown')
  const mig = snapshotOf([
    ...observe('harbor.example', fetched(page(HUB)), ['HubSpot'], T0).observations, ...observe('harbor.example', fetched(page('')), ['HubSpot'], T0 + 30 * DAY).observations, ...observe('harbor.example', fetched(page('')), ['HubSpot'], T0 + 60 * DAY).observations])
  const m = matchesFilter(mig, { migratedFrom: 'HubSpot' }); assert.equal(m.match, 'yes'); assert.match(m.reasons[0], /two comparable dated observations/)
})

test('technology fit is a separate label from a buying reason; discovery queries come from the filter', () => {
  assert.equal(techLabel({ match: 'yes' }, null).readiness, 'tech_fit_only')
  assert.equal(techLabel({ match: 'yes' }, { date: '2026-10-01', source_url: 'https://n.example/a' }).readiness, 'tech_fit_with_reason')
  assert.equal(techLabel({ match: 'unknown' }, { date: '2026-10-01', source_url: 'x' }).readiness, 'not_a_fit')
  const q = techQueries({ uses: ['Shopify'], migratedFrom: 'HubSpot', migratedTo: 'Salesforce' }, ['Austin']); assert.ok(q.some(s => /Shopify/.test(s)) && q.some(s => /migrated from HubSpot to Salesforce/.test(s)))
})

bothEngines('observations are stored per tenant and reload for change detection', async ({ db }) => {
  const a = observe('harbor.example', fetched(page(HUB)), ['HubSpot'], T0).observations, b = observe('harbor.example', fetched(page('')), ['HubSpot'], T0 + DAY).observations
  await recordObservations(db, 't1', [...a, ...b]); await recordObservations(db, 't1', a)
  const mine = await loadObservations(db, 't1', 'https://www.harbor.example/x')
  assert.equal(mine.filter(o => o.tech === 'HubSpot').length, 2); assert.equal((await loadObservations(db, 't2', 'harbor.example')).length, 0)
  assert.equal(snapshotOf(mine).changes.get('hubspot')!.kind, 'unconfirmed')
})
