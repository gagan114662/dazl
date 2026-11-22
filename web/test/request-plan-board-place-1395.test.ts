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
  ['a reply that is not JSON', 'Toronto, Ontario is the place.', 'skipped_request_plan:schema'],
  ['a reply with an extra key', { ...plan([{ text: 'Toronto, Ontario', city: 'Toronto', region: 'Ontario', country: 'CA' }]), radius_km: 50 }, 'skipped_request_plan:schema'],
  ['a place the request does not write', plan([{ text: 'Montreal', city: 'Montreal', region: null, country: 'CA' }]), 'skipped_request_plan:place_not_in_request'],
  ['a country the request neither writes nor implies', plan([{ text: 'Toronto, Ontario', city: 'Toronto', region: 'Ontario', country: 'US' }]), 'skipped_request_plan:place_not_in_request'],
  ['a model error', 'provider_error', 'skipped_request_plan:error'],
  ['no plan reply at all (the stub answers with the extraction list)', undefined, 'skipped_request_plan:schema'],
] as const) {
  test(`#1395 runJob: ${name} holds the job boards (${status}); no posting is read and the words are never read instead`, async () => {
    const { http, seen } = board()
    const x = await runFixture(fx(http, REAL, ['Toronto, Ontario'], 'CA', modelPlan as Fixture['modelPlan']))
    assert.deepEqual(detailed(seen), [], 'no posting was detail-fetched')
    assert.ok(!seen.some(u => u.includes('boards-api.greenhouse.io')), 'no board was even listed')
    assert.equal(boardsStatus(x), status)
  })
}

// Quest (#1395 review): never search a different place than the request named. A place the request writes but the board source cannot place
// (a bare country) holds the board source; the profile's one place is NOT searched instead.
// PM 2026-11-22 (changed from #1395, which held a bare "Canada"): the request's country is read on the boards; the profile place (Toronto) is
// still never searched instead of what the request names.
test('#1395 runJob: a request naming only "Canada" reads the boards on Canada, never narrowed to the profile place (Toronto)', async () => {
  const { http, seen } = board()
  const x = await runFixture(fx(http, 'SaaS startups in Canada hiring account executives', ['Toronto'], 'CA',
    plan([{ text: 'Canada', city: null, region: null, country: 'CA' }])))
  assert.ok(['ok', 'partial'].includes(boardsStatus(x) ?? ''), `ran: ${boardsStatus(x)}`)
  assert.ok(detailed(seen).length > 0 && detailed(seen).every(i => i >= 3), `Canadian postings only (got ${JSON.stringify(detailed(seen))})`)
})

// Quest: a refused reservation for the plan call holds ONLY the board source; the rest of the scan finishes, and nothing comes from the boards.
test('#1395 runJob: a refused spend reservation for the plan holds only the job boards; the scan still finishes and no board item reaches extraction', async () => {
  const { http, seen } = board()
  const x = await runFixture(fx(http, REAL, ['Toronto, Ontario'], 'CA', 'spend_refused'))
  assert.equal(x.job.status, 'done', `the scan finished: ${JSON.stringify(x.job)}`)
  assert.equal(boardsStatus(x), 'skipped_request_plan:spend_refused')
  assert.ok(!seen.some(u => u.includes('boards-api.greenhouse.io')), 'no board was listed')
  assert.ok(!x.calls.prompts.some(p => p.includes('"source":"jobboards"')), 'no board item reached extraction')
})

// Council review (haiku R6): a board source the USER picked is held by a bad plan too; the other picked source still runs.
test('#1395 runJob: explicit sources (jobboards + careers) with a bad plan: the job boards are held, the careers source still runs', async () => {
  const { http, seen } = board()
  const x = await runFixture({ ...fx(http, REAL, ['Toronto, Ontario'], 'CA', 'Toronto, Ontario is the place.'), sources: JSON.stringify({ adapters: ['jobboards', 'careers'] }) })
  assert.equal(boardsStatus(x), 'skipped_request_plan:schema')
  assert.ok(!seen.some(u => u.includes('boards-api.greenhouse.io')), 'no board was listed')
  const careers = x.db.prepare("SELECT status FROM scan_source_runs WHERE collector = 'adapter:careers'").get() as { status: string } | undefined
  assert.ok(careers, 'the careers source the user picked still ran')
})

// Quest: a tenant whose model key is not Claude keeps the board source exactly as before (no silent loss): no plan call is made (Claude is the
// only paid API the plan may use) and the place is read as main read it.
test('#1395 runJob: a non-Claude tenant keeps the job boards as before: no plan call, the Toronto postings are read', async () => {
  const { http, seen } = board()
  const x = await runFixture({ ...fx(http, REAL, ['Toronto, Ontario'], 'CA', undefined), vendor: 'openai' })
  assert.ok(!x.calls.prompts.some(p => p.startsWith('You read one B2B prospecting request')), 'no plan call for a non-Claude tenant')
  assert.deepEqual(detailed(seen), [3, 4], `the Toronto postings were read as on main (got ${JSON.stringify(detailed(seen))})`)
  assert.ok(['ok', 'partial'].includes(boardsStatus(x) ?? ''), `the job boards ran: ${boardsStatus(x)}`)
})

// Qodo Medium (#1527): a bare US city name is a US place only for a US profile (main's profilePlace rule, #1205 review F1): a UK profile's
// "Birmingham" is never Birmingham, AL, whatever country the model guessed.
test('#1395 runJob: a UK profile\'s request for "Birmingham" with a model guess of US never searches Birmingham, AL', async () => {
  const { http, seen } = board()
  const x = await runFixture(fx(http, 'SaaS firms hiring account executives in Birmingham', ['Birmingham'], 'GB',
    plan([{ text: 'Birmingham', city: 'Birmingham', region: null, country: 'US' }])))
  assert.ok(!seen.some(u => u.includes('boards-api.greenhouse.io')), 'no board was listed for a US Birmingham')
  assert.match(boardsStatus(x) ?? '', /^skipped_/)
})

// Qodo Medium (#1527): an industry word the model returns as the city ("Fintech") is not a place the data knows in that state: the board source
// holds (a named reason) rather than searching a city "Fintech, CA" (#1171), and never widens an unknown city to its whole state.
test('#1395 runJob: a model reply naming "Fintech" as the city of California holds the boards; no "Fintech, CA" search', async () => {
  const { http, seen } = board()
  const x = await runFixture(fx(http, 'Companies in Fintech, California hiring account executives', ['California'], 'US',
    plan([{ text: 'Fintech, California', city: 'Fintech', region: 'California', country: 'US' }])))
  assert.ok(!seen.some(u => u.includes('boards-api.greenhouse.io')), 'no board was listed for a city that is no place')
  assert.match(boardsStatus(x) ?? '', /^skipped_no_place:city:/)
})

// Qodo Low (#1527): a job-board source the user PICKED, whose request names a place the boards cannot place ("Canada") or no place at all, is held
// with the named reason, never run with no place (which recorded "empty" over the reason). The other picked source still runs.
test('#1395 runJob: picked job boards with an unplaceable or absent request place record the reason, not "empty"', async () => {
  for (const [req, places, want] of [
    // PM 2026-11-22 (changed): a bare country now runs (test above); a region the boards cannot place still records its reason
    ['SaaS startups in Europe hiring account executives', [{ text: 'Europe', city: null, region: 'Europe', country: null }], /^skipped_no_place:region:Europe/],
  ] as const) {
    const { http, seen } = board()
    const x = await runFixture({ ...fx(http, req, [], 'CA', plan([...places])), sources: JSON.stringify({ adapters: ['jobboards', 'careers'] }) })
    assert.ok(!seen.some(u => u.includes('boards-api.greenhouse.io')), `${req}: no board was listed`)
    assert.match(boardsStatus(x) ?? '', want, req)
    const careers = x.db.prepare("SELECT status FROM scan_source_runs WHERE collector = 'adapter:careers'").get() as { status: string } | undefined
    assert.ok(careers, `${req}: the careers source the user picked still ran`)
  }
})
// PM ruling 2026-11-22 (changed from #1527/#1395, which held a picked board source with no place): a picked board source whose request names no
// place now runs, here on the ICP's country (CA).
test('PM ruling: picked job boards with NO request place run on the ICP country', async () => {
  const { http, seen } = board()
  const x = await runFixture({ ...fx(http, 'SaaS startups hiring account executives', [], 'CA', plan([])), sources: JSON.stringify({ adapters: ['jobboards', 'careers'] }) })
  assert.ok(['ok', 'partial', 'empty'].includes(boardsStatus(x) ?? ''), `ran: ${boardsStatus(x)}`)
  assert.ok(seen.includes('https://boards-api.greenhouse.io/v1/boards/plannedco/jobs'), 'the board was read')
  assert.ok(detailed(seen).every(i => i >= 3), `Canadian postings only (got ${JSON.stringify(detailed(seen))})`)
})

// PM ruling 2026-11-22 (overrides #1205/#1395 for a request with NO place): the job boards still run - on the ICP's country when one is set,
// otherwise with no place filter. Never skipped for lack of a place. Case 1's exact prompt (run af02437c recorded skipped_no_place).
const CASE1 = 'Find B2B companies (5-200 employees) doing outbound sales that show a dated buying signal in the last 45 days: hiring their first SDR/BDR or sales rep, new funding, a new Head of Sales/VP Sales, or a founder still doing sales. Buyer: Founder, CEO or Head of Sales. seller = dazl (dazl.ai): AI that finds high-intent leads and drafts reviewed cold outreach from your own Gmail.'
test('PM ruling: case 1 (no place, no ICP country) reaches the job boards with no place filter, status ok', async () => {
  const { http, seen } = board()
  const x = await runFixture(fx(http, CASE1, [], '', plan([])))
  assert.ok(['ok', 'partial'].includes(boardsStatus(x) ?? ''), `the job boards ran: ${boardsStatus(x)}`)
  assert.ok(seen.includes('https://boards-api.greenhouse.io/v1/boards/plannedco/jobs'), 'the board was read')
})
test('PM ruling: case 1 with ICP country US reads only US postings', async () => {
  const { http, seen } = board()
  const x = await runFixture(fx(http, CASE1, [], 'US', plan([])))
  assert.ok(['ok', 'partial'].includes(boardsStatus(x) ?? ''), `the job boards ran: ${boardsStatus(x)}`)
  assert.ok(detailed(seen).every(i => i <= 2), `US postings only (got ${JSON.stringify(detailed(seen))})`)
})

// Qodo #1556: a profile place the boards cannot resolve ("Europe") is a place, not none: still held, never run worldwide or narrowed to the country.
test('Qodo #1556: a place-free request with profile where ["Europe"] keeps the skip reason', async () => {
  for (const country of ['', 'DE']) {
    const { http, seen } = board()
    const x = await runFixture(fx(http, CASE1, ['Europe'], country, plan([])))
    assert.match(boardsStatus(x) ?? '', /^skipped_no_place/, `country=${country}`)
    assert.ok(!seen.some(u => u.includes('boards-api.greenhouse.io')), 'no board was listed')
  }
})

// PM 2026-11-22: a bare country ("Canada"), in the request or the profile, reads the boards on that country - any country name.
test('PM: a request naming only "Canada" reads the Canadian boards', async () => {
  const { http, seen } = board()
  const x = await runFixture(fx(http, 'SaaS startups in Canada hiring account executives', [], '', plan([{ text: 'Canada', city: null, region: null, country: 'CA' }])))
  assert.ok(['ok', 'partial'].includes(boardsStatus(x) ?? ''), `ran: ${boardsStatus(x)}`)
  assert.ok(detailed(seen).length > 0 && detailed(seen).every(i => i >= 3), `Canadian postings only (got ${JSON.stringify(detailed(seen))})`)
})
test('PM: a profile naming only "United States" reads the US boards for a place-free request', async () => {
  const { http, seen } = board()
  const x = await runFixture(fx(http, CASE1, ['United States'], '', plan([])))
  assert.ok(['ok', 'partial'].includes(boardsStatus(x) ?? ''), `ran: ${boardsStatus(x)}`)
  assert.ok(detailed(seen).length > 0 && detailed(seen).every(i => i <= 2), `US postings only (got ${JSON.stringify(detailed(seen))})`)
})
