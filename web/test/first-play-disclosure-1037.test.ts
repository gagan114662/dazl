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
  assert.equal(row(e, 'sources_free')!.note, 'Leads come from free sources first')
  assert.ok(!e.rows.some(r => r.id === 'tinyfish_search'), 'no ordinary lead search row')
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

// Through the server path (estimateForBody, as /api/scan/estimate calls it): the env the runner reads decides the row.
import Database from 'better-sqlite3'
import { asDb } from '../lib/db/client.ts'
import { estimateForBody } from '../lib/scan/estimate-request.ts'
async function withEnv<T>(env: Record<string, string | undefined>, f: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k] }
  try { return await f() } finally { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k] } }
}
const serverEstimate = async (hasOwnKey = true) => {
  const r = await estimateForBody({ mode: 'first5', query: 'B2B SaaS hiring a first SDR' }, { db: asDb(new Database(':memory:')), tenantId: 't1', hasOwnKey, enrichmentVendors: [], model: 'claude-sonnet-4-5' })
  assert.ok(r.ok, JSON.stringify(r)); return (r as { estimate: ReturnType<typeof estimateRun> }).estimate
}

test('#1037 server estimate: people search off (PEOPLE_SEARCH_ENABLED=0, or no TinyFish key) -> no people row; a lowered cap flows through', async () => {
  await withEnv({ PEOPLE_SEARCH_ENABLED: '0', TINYFISH_API_KEY: 'k', DAZL_FIRST_PLAY_PEOPLE_SEARCHES: undefined }, async () => assert.equal(row(await serverEstimate(), 'people_search'), undefined))
  await withEnv({ PEOPLE_SEARCH_ENABLED: undefined, TINYFISH_API_KEY: undefined, TINYFISH_ENABLED: undefined, DAZL_FIRST_PLAY_PEOPLE_SEARCHES: undefined }, async () => assert.equal(row(await serverEstimate(), 'people_search'), undefined))
  await withEnv({ PEOPLE_SEARCH_ENABLED: undefined, TINYFISH_API_KEY: 'k', DAZL_FIRST_PLAY_PEOPLE_SEARCHES: '3' }, async () => assert.deepEqual(row(await serverEstimate(), 'people_search')!.units, { min: 0, max: 3 }))
  await withEnv({ PEOPLE_SEARCH_ENABLED: undefined, TINYFISH_API_KEY: 'k', DAZL_FIRST_PLAY_PEOPLE_SEARCHES: '0' }, async () => assert.equal(row(await serverEstimate(), 'people_search'), undefined))
})

test('#1037 trial people searches are priced at the trial TinyFish price and say they come from the trial reserve', () => {
  const e = estimateRun({ budget: FIRST5, payer: 'trial', firstPlayPeopleSearches: 10, trialTinyfishSearchUsd: 0.005, env: { DAZL_PRICE_TINYFISH_SEARCH_USD: '0.5' } })
  const p = row(e, 'people_search')!
  assert.deepEqual(p.usd, { min: 0, max: 0.05 }, 'the trial price, not the own-key price')
  assert.match(p.note ?? '', /paid from the free-trial reserve and never from its last 25%, so fewer may run/)
  const own = row(estimateRun({ budget: FIRST5, payer: 'you', firstPlayPeopleSearches: 10, trialTinyfishSearchUsd: 0.005, env: { DAZL_PRICE_TINYFISH_SEARCH_USD: '0.5' } }), 'people_search')!
  assert.deepEqual(own.usd, { min: 0, max: 5 }, 'an own-key first play keeps the operator price')
})

test('#1037 edge counts: a trial with people search off says "plus 0"; negative, NaN or fractional counts fall back to the maximum', () => {
  assert.match(row(estimateRun({ budget: null, payer: 'trial', firstPlayPeopleSearches: 0 }), 'tinyfish_search')!.note ?? '', /plus 0 people searches/)
  for (const bad of [-1, Number.NaN, 2.5]) assert.equal(row(estimateRun({ budget: FIRST5, payer: 'trial', firstPlayPeopleSearches: bad }), 'people_search')!.units.max, FIRST_PLAY_MAX, String(bad))
})

test('#1037 run-budget disclosure follows the server count: 0 -> off (no TinyFish call), 3 -> "up to 3"', () => {
  const off = describeRunBudget(FIRST5, { firstPlayPeopleSearches: 0, firstPlayLead: { searches: 0, fetches: 0 } }).surfaces.find(x => x.surface === 'search_and_fetch')!
  assert.equal(off.status, 'off'); assert.match(off.note, /no TinyFish search, fetch or post-scan people search/)
  const three = describeRunBudget(FIRST5, { firstPlayPeopleSearches: 3 }).surfaces.find(x => x.surface === 'search_and_fetch')!
  assert.equal(three.status, 'not_covered'); assert.match(three.note, /up to 3 TinyFish people searches/)
})

// Hermes review (CHANGES REQUIRED at bce374aa, finding 1): no string anywhere in the disclosure may name a people-search cap other
// than the one the run uses - surfaces, excluded_paths and limits alike.
const peopleCaps = (d: ReturnType<typeof describeRunBudget>) => [...d.surfaces.map(s => s.note), ...d.excluded_paths, ...d.limits]
  .flatMap(t => /people|People search/.test(t) ? [...t.matchAll(/(?:up to|at most) (\d+) (?:TinyFish )?(?:people )?searches/gi)].map(m => Number(m[1])) : [])
test('#1037 first5 disclosure states ONE people-search cap everywhere: N for N = 10, 3; none at all for 0', () => {
  for (const n of [10, 3]) {
    const d = describeRunBudget(FIRST5, { firstPlayPeopleSearches: n })
    assert.deepEqual([...new Set(peopleCaps(d))], [n], `N=${n}: ${JSON.stringify(peopleCaps(d))}`)
    assert.ok(d.excluded_paths.some(x => x.startsWith(`People search after the scan - a first play or free-trial scan: up to ${n} `)))
  }
  const off = describeRunBudget(FIRST5, { firstPlayPeopleSearches: 0 })
  assert.deepEqual(peopleCaps(off), [], JSON.stringify(off.excluded_paths))
  assert.ok(!off.excluded_paths.some(x => x.startsWith('People search after the scan')), 'the people line is dropped at 0')
})
test('#1037 a free-trial scan with a budget states the trial cap; an ordinary scan keeps "at most 5"', () => {
  const trial = describeRunBudget({ max_usd: 1 }, { firstPlayPeopleSearches: 10, trial: true })
  assert.ok(trial.excluded_paths.some(x => /a first play or free-trial scan: up to 10 /.test(x)))
  assert.ok(!trial.excluded_paths.some(x => /at most 5 TinyFish searches/.test(x)))
  const own = describeRunBudget({ max_usd: 1 }, { firstPlayPeopleSearches: 10 })
  assert.ok(own.excluded_paths.some(x => /^People search after the scan - at most 5 TinyFish searches/.test(x)))
})
// Finding 3: a non-first5 trial scan's people searches are paid from the trial reserve at the trial price.
test('#1037 trial (non-first5) search row: lead searches at the operator price, people searches at the trial price', () => {
  const e = estimateRun({ budget: null, payer: 'trial', firstPlayPeopleSearches: 10, trialTinyfishSearchUsd: 0.004, env: { DAZL_PRICE_TINYFISH_SEARCH_USD: '0.5' } })
  const r = row(e, 'tinyfish_search')!
  const leadSearches = r.units.max - 10
  assert.equal(Math.round(r.usd!.max * 1e6) / 1e6, Math.round((0.5 * leadSearches + 0.004 * 10) * 1e6) / 1e6)
  assert.match(r.note ?? '', /people searches are paid from the free-trial reserve at \$0\.0040? each/)
  const own = row(estimateRun({ budget: null, payer: 'you', firstPlayPeopleSearches: 10, trialTinyfishSearchUsd: 0.004, env: { DAZL_PRICE_TINYFISH_SEARCH_USD: '0.5' } }), 'tinyfish_search')!
  assert.equal(Math.round(own.usd!.max * 1e6) / 1e6, Math.round(0.5 * own.units.max * 1e6) / 1e6, 'an own-key scan prices every search at the operator price')
})

test('#1037 item 1: the first-play estimate states the capped lead-search fallback, priced, and drops it when the operator turns it off', () => {
  const e = estimateRun({ budget: FIRST5, payer: 'trial', trialTinyfishSearchUsd: 0.02, env: { DAZL_PRICE_TINYFISH_FETCH_USD: '0.01' } })
  const l = row(e, 'first_play_lead_search')!
  assert.deepEqual(row(estimateRun({ budget: FIRST5, payer: 'trial', trialTinyfishSearchUsd: 0.02, trialTinyfishFetchUsd: 0.005, env: { DAZL_PRICE_TINYFISH_FETCH_USD: '0.01' } }), 'first_play_lead_search')!.usd, { min: 0, max: 0.02 * 3 + 0.005 * 6 }, 'a trial pays page reads at the trial price')
  assert.equal(l.provider, 'TinyFish'); assert.deepEqual(l.units, { min: 0, max: 3 })
  assert.deepEqual(l.usd, { min: 0, max: 0.02 * 3 + 0.01 * 6 })
  assert.match(l.note ?? '', /Only when free news cannot serve the play: at most 3 TinyFish searches and 6 page reads/)
  assert.deepEqual(row(estimateRun({ budget: FIRST5, payer: 'trial', env: { DAZL_FIRST_PLAY_LEAD_SEARCHES: '1' } }), 'first_play_lead_search')!.units, { min: 0, max: 1 })
  assert.equal(row(estimateRun({ budget: FIRST5, payer: 'trial', env: { DAZL_FIRST_PLAY_LEAD_SEARCHES: '0' } }), 'first_play_lead_search'), undefined)
  assert.equal(row(estimateRun({ budget: { paid_fallback: false }, payer: 'trial', env: {} }), 'first_play_lead_search'), undefined, 'not a first play: no fallback row')
})
