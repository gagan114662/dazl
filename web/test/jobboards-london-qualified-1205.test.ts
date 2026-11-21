// #1205 wrong geography, generalised: a London qualified by ANY place outside the UK (a US state or its code, a Canadian province, a
// non-UK country) is not the UK's London. Main handled only six spelled-out qualifiers (Ontario, Canada, Kentucky, Ohio, Arkansas, Texas),
// so "London, Indiana" / "London, IN" / "London, West Virginia" / "London, Alberta" were answered with UK postings. The first test runs the
// REAL runJob (stubbed only at the edges: search, board JSON, pages, model) on the real store. Postings and practices are INVENTED.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture, type Cand } from './helpers/acceptance-harness.ts'
import type { SafeGet } from '../lib/sources/types.ts'
import { placeIn } from '../lib/sources/jobboards.ts'

const LOCS = ['London, UK', 'London, England, United Kingdom', 'London, IN', 'Greater London']
const NAMES = ['Thames', 'Westminster', 'Hoosier', 'Camden']
const QUOTE = (i: number) => `${NAMES[i]} Family Dental is hiring a front desk receptionist to greet patients at its ${LOCS[i]} office`
const gh = (i: number) => `https://boards.greenhouse.io/londonsmiles/jobs/${i + 1}`
function board() {
  const seen: string[] = []
  const http: SafeGet = async url => {
    if (new URL(url).hostname === 'hn.algolia.com') return null
    seen.push(url); const j = (o: unknown) => ({ status: 200, body: JSON.stringify(o) })
    if (url === 'https://boards-api.greenhouse.io/v1/boards/londonsmiles/jobs') return j({ jobs: LOCS.map((l, i) => ({ id: i + 1, title: 'Front Desk Receptionist', updated_at: daysAgo(1), location: { name: l }, absolute_url: gh(i) })) })
    const d = url.match(/\/jobs\/(\d+)$/); if (d) { const i = +d[1] - 1; return j({ id: i + 1, title: 'Front Desk Receptionist', first_published: daysAgo(9), content: `&lt;p&gt;${QUOTE(i)}.&lt;/p&gt;`, location: { name: LOCS[i] }, absolute_url: gh(i) }) }
    return null
  }
  return { http, seen }
}
function fx(sourceHttp: SafeGet, where: string): Fixture {
  const request = `Find independent dental practices in ${where} that posted a front desk receptionist job in the past 90 days.`
  const icp = { summary: `${where} dental practices hiring`, who: ['Practice manager'], industries: ['dental'], sizes: [], where: [where], signals: ['posted a front desk receptionist job'], exclude: [], country: 'US', language: 'en' }
  // the stubbed model would turn EVERY posting into a candidate: the place must be settled before extraction, not by it
  const extraction: Cand[] = LOCS.map((_, i) => ({ company: `${NAMES[i]} Family Dental`, signal: 'front desk receptionist job', source_url: gh(i), excerpt: QUOTE(i), event_date: daysAgo(9) }))
  return { request, modelIcp: icp, modelQueries: ['dental front desk receptionist job London'], hits: [{ url: gh(2), title: 'Front Desk Receptionist', snippet: QUOTE(2), date: daysAgo(9) }], tfPages: {},
    own: Object.fromEntries(LOCS.map((_, i) => [gh(i), { title: 'Front Desk Receptionist', text: `Posted ${daysAgo(9)}. ${QUOTE(i)}. ${' The practice welcomes patients every week.'.repeat(8)}` }])), extraction, deps: { sourceHttp } }
}

for (const where of ['London, Indiana', 'London, IN']) {
  test(`#1205 runJob: a request for ${where} reads only the London, IN posting; the UK London postings are never detail-fetched, never reach extraction and are never a qualified lead`, async () => {
    const { http, seen } = board()
    const x = await runFixture(fx(http, where))
    const details = seen.filter(u => /\/jobs\/\d+$/.test(u)).map(u => u.split('/').pop())
    assert.deepEqual(details, ['3'], `only the London, IN posting was detail-fetched (got ${JSON.stringify(details)})`)
    const adapterPrompt = x.calls.prompts.find(p => p.includes('"source":"jobboards"'))
    assert.ok(adapterPrompt, 'the job-board items were given to extraction')
    assert.ok(adapterPrompt.includes(gh(2)), 'the London, IN posting reached extraction')
    for (const i of [0, 1, 3]) assert.ok(!adapterPrompt.includes(gh(i)), `UK posting '${LOCS[i]}' never reached extraction`)
    const qualified = x.leads.filter(l => !l.review_reason).map(l => l.source_url)
    for (const i of [0, 1, 3]) assert.ok(!qualified.includes(gh(i)), `UK posting '${LOCS[i]}' is not a qualified lead`)
    const run = x.db.prepare("SELECT status FROM scan_source_runs WHERE collector = 'adapter:jobboards'").get() as { status: string }
    assert.ok(['ok', 'partial'].includes(run.status), `the job boards ran on the intended place: ${run.status}`)
  })
}

test('#1205 a London qualified by any US state (name or code), Canadian province or non-UK country refuses UK postings; the UK London is unchanged', () => {
  const UK = ['London, UK', 'London, England', 'London, England, United Kingdom', 'Greater London', 'London']
  for (const q of ['in London, Indiana', 'in London, IN', 'in London, West Virginia', 'in London, WV', 'in London, GA', 'in London, Alberta', 'in London, AB',
    'in London, Ontario', 'in London, ON', 'in London, ONT', 'in London, Kentucky', 'in London, Ontario, Canada', 'in London, Canada', 'in London Ontario', 'in London, Australia']) {
    const p = placeIn(q)
    if (p) for (const l of UK) assert.equal(p.ok(l), false, `${q} resolved to '${p.name}', which accepts the UK posting '${l}'`)
  }
  // the place a qualified London resolves to is that London, read by the resolver for its qualifier
  assert.equal(placeIn('in London, Indiana')?.name, 'London, IN')
  assert.equal(placeIn('in London, WV')?.name, 'London, WV')
  assert.equal(placeIn('in London, Alberta')?.ok('London, AB'), true)
  // the UK London is unchanged: bare, with a UK marker, or followed by words that are not a place
  for (const q of ['hiring sales staff in London', 'in London, UK', 'in London, England', 'London UK B2B SaaS startups hiring sales staff', 'in London, United Kingdom',
    'London-based fintechs hiring SDRs', 'in London, hiring account executives', 'in London, the startups hiring', 'in London, EC1A', 'in London, AI startups hiring']) {
    const p = placeIn(q)
    assert.equal(p?.name, 'London', `${q} stays the UK London`)
    assert.equal(p!.ok('London, UK'), true, q)
    assert.equal(p!.ok('London, IN'), false, `${q} refuses London, IN`)
  }
})
