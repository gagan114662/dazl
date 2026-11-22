// #1395: the job boards' place is read from the REQUEST PLAN (one model call, schema-checked, every place grounded in the request), never from the
// request's words by regex. The runJob tests run the REAL runner on the real store, stubbed only at the edges (search, board JSON, pages, model).
// REAL wording: "Companies in Fintech, California hiring account executives" is the #1171 request (main read it as the city "Fintech, CA"
// and read no board); "Dental clinics in Toronto, Ontario that opened a new location or are hiring front-desk staff in the last 90 days" is a prod
// matrix request (test/fixtures/matrix-1099.json). SYNTHETIC: the French request, every posting, company and the model's replies.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture, type Cand } from './helpers/acceptance-harness.ts'
import type { SafeGet } from '../lib/sources/types.ts'

const LOCS = ['Los Angeles, CA', 'San Francisco, California', 'Austin, TX', 'Toronto, ON, Canada', 'Toronto, Canada', 'Vancouver, BC, Canada']
const NAMES = ['Pacific Ledger', 'Bayline Pay', 'Lonestar Books', 'Maple Clearing', 'Lakeshore Smiles', 'Harbour Dental']
const TITLE = 'SaaS Account Executive, front desk and sales'
const QUOTE = (i: number) => `${NAMES[i]} is hiring an account executive and front desk staff for its ${LOCS[i]} office`
const gh = (i: number) => `https://boards.greenhouse.io/plannedco/jobs/${i + 1}`
function board() {
  const seen: string[] = []
  const http: SafeGet = async url => {
    if (new URL(url).hostname === 'hn.algolia.com') return null
    seen.push(url); const j = (o: unknown) => ({ status: 200, body: JSON.stringify(o) })
    if (url === 'https://boards-api.greenhouse.io/v1/boards/plannedco/jobs') return j({ jobs: LOCS.map((l, i) => ({ id: i + 1, title: TITLE, updated_at: daysAgo(1), location: { name: l }, absolute_url: gh(i) })) })
    const d = url.match(/\/jobs\/(\d+)$/); if (d) { const i = +d[1] - 1; return j({ id: i + 1, title: TITLE, first_published: daysAgo(9), content: `&lt;p&gt;${QUOTE(i)}.&lt;/p&gt;`, location: { name: LOCS[i] }, absolute_url: gh(i) }) }
    return null
  }
  return { http, seen }
}
type PlanPlace = { text: string; city: string | null; region: string | null; country: string | null }
const plan = (places: PlanPlace[], language = 'en') => ({ offer: null, buyer_type: 'account executive', industry_code: null, places, signals: [{ kind: 'hiring', text: 'hiring', negated: false }], exclusions: [], language })
function fx(sourceHttp: SafeGet, request: string, where: string[], country: string, modelPlan: Fixture['modelPlan']): Fixture {
  const icp = { summary: request.slice(0, 80), who: ['Founder'], industries: ['software'], sizes: [], where, signals: ['hiring account executives'], exclude: [], country, language: 'en' }
  const extraction: Cand[] = LOCS.map((_, i) => ({ company: NAMES[i], signal: 'hiring an account executive', source_url: gh(i), excerpt: QUOTE(i), event_date: daysAgo(9) }))
  return { request, modelIcp: icp, modelQueries: ['account executive hiring'], hits: [{ url: gh(0), title: TITLE, snippet: QUOTE(0), date: daysAgo(9) }], tfPages: {},
    own: Object.fromEntries(LOCS.map((_, i) => [gh(i), { title: TITLE, text: `Posted ${daysAgo(9)}. ${QUOTE(i)}. ${' The team works with customers every week.'.repeat(8)}` }])), extraction, deps: { sourceHttp }, modelPlan }
}
const detailed = (seen: string[]) => seen.filter(u => /\/jobs\/\d+$/.test(u)).map(u => +u.split('/').pop()! - 1).sort()
const boardsStatus = (x: Awaited<ReturnType<typeof runFixture>>) => (x.db.prepare("SELECT status FROM scan_source_runs WHERE collector = 'adapter:jobboards'").get() as { status: string } | undefined)?.status

test('#1395 runJob (#1171 wording): "Companies in Fintech, California hiring account executives" reads the California boards; "Fintech" is not a city', async () => {
  const { http, seen } = board()
  const x = await runFixture(fx(http, 'Companies in Fintech, California hiring account executives', ['California'], 'US',
    plan([{ text: 'California', city: null, region: 'California', country: 'US' }])))
  assert.deepEqual(detailed(seen), [0, 1], `only the two California postings were detail-fetched (got ${JSON.stringify(detailed(seen))})`)
  assert.ok(['ok', 'partial'].includes(boardsStatus(x) ?? ''), `the job boards ran on California: ${boardsStatus(x)}`)
  assert.ok(x.calls.prompts.some(p => p.startsWith('You read one B2B prospecting request')), 'the request was read by the plan call')
})

test('#1395 runJob: a French request "à Toronto, Canada" reads the Toronto boards (main read the city "à Toronto" and matched no posting)', async () => {
  const { http, seen } = board()
  await runFixture(fx(http, 'Startups SaaS à Toronto, Canada qui recrutent des commerciaux', ['Toronto'], 'CA',
    plan([{ text: 'Toronto, Canada', city: 'Toronto', region: null, country: 'CA' }], 'fr')))
  assert.deepEqual(detailed(seen), [3, 4], `only the two Toronto postings were detail-fetched (got ${JSON.stringify(detailed(seen))})`)
})

test('#1395 runJob (real prod wording): "Dental clinics in Toronto, Ontario ..." still reads only Toronto, Ontario', async () => {
  const { http, seen } = board()
  await runFixture(fx(http, 'Dental clinics in Toronto, Ontario that opened a new location or are hiring front-desk staff in the last 90 days', ['Toronto, Ontario'], 'CA',
    plan([{ text: 'Toronto, Ontario', city: 'Toronto', region: 'Ontario', country: 'CA' }])))
  assert.deepEqual(detailed(seen), [3, 4], `Toronto, ON and Toronto, Canada only; never Vancouver, BC (got ${JSON.stringify(detailed(seen))})`)
})

// Fail closed: each of these held the board source with a named status, read no posting, and did NOT fall back to the words (which name Toronto).
const REAL = 'Dental clinics in Toronto, Ontario that opened a new location or are hiring front-desk staff in the last 90 days'
for (const [name, modelPlan, status] of [
  ['a reply that is not JSON', 'Toronto, Ontario is the place.', 'held_request_plan:schema'],
  ['a reply with an extra key', { ...plan([{ text: 'Toronto, Ontario', city: 'Toronto', region: 'Ontario', country: 'CA' }]), radius_km: 50 }, 'held_request_plan:schema'],
  ['a place the request does not write', plan([{ text: 'Montreal', city: 'Montreal', region: null, country: 'CA' }]), 'held_request_plan:place_not_in_request'],
  ['a country the request neither writes nor implies', plan([{ text: 'Toronto, Ontario', city: 'Toronto', region: 'Ontario', country: 'US' }]), 'held_request_plan:place_not_in_request'],
  ['a model error', 'provider_error', 'held_request_plan:error'],
  ['no plan reply at all (the stub answers with the extraction list)', undefined, 'held_request_plan:schema'],
] as const) {
  test(`#1395 runJob: ${name} holds the job boards (${status}); no posting is read and the words are never read instead`, async () => {
    const { http, seen } = board()
    const x = await runFixture(fx(http, REAL, ['Toronto, Ontario'], 'CA', modelPlan as Fixture['modelPlan']))
    assert.deepEqual(detailed(seen), [], 'no posting was detail-fetched')
    assert.ok(!seen.some(u => u.includes('boards-api.greenhouse.io')), 'no board was even listed')
    assert.equal(boardsStatus(x), status)
  })
}
