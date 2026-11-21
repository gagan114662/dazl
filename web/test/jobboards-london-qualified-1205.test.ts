// #1205 wrong geography, generalised: a London qualified by ANY place outside the UK (a US state or its code, a Canadian province, a
// non-UK country) is not the UK's London. Main handled only six spelled-out qualifiers (Ontario, Canada, Kentucky, Ohio, Arkansas, Texas),
// so "London, Indiana" / "London, IN" / "London, West Virginia" / "London, Alberta" were answered with UK postings. The first test runs the
// REAL runJob (stubbed only at the edges: search, board JSON, pages, model) on the real store. Postings and practices are INVENTED.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture, type Cand } from './helpers/acceptance-harness.ts'
import type { SafeGet } from '../lib/sources/types.ts'
import { placeIn, placeSkipReason, profilePlace } from '../lib/sources/jobboards.ts'
import { regionOf } from '../lib/scan/countries.ts'

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
  // UK posting forms, including ones that name no country: a UK postcode, the City of London, a remote London posting
  const UK = ['London, UK', 'London, England', 'London, England, United Kingdom', 'Greater London', 'London', 'London EC2A 2BB', 'London, SE1', 'City of London', 'London Bridge', 'Remote - London']
  for (const q of ['in London, Indiana', 'in London, IN', 'in London, West Virginia', 'in London, WV', 'in London, GA', 'in London, Alberta', 'in London, AB',
    'in London, Ontario', 'in London, ON', 'in London, ONT', 'in London, Kentucky', 'in London, Ontario, Canada', 'in London, Canada', 'in London Ontario', 'in London, Australia',
    'in London, Ky.', 'in London, W.Va.', 'in London, Ky', 'in london, ky', 'in london, in', 'London (Ontario)', 'London (KY)', 'London ON', 'in London, Ont.', 'in London/Ontario', 'in London | ON', 'in London, (Ontario)',
    'in London \u2013 ON', 'in London \u2013 Ontario', 'in London\u2014Ontario', 'in London-Ontario', 'in London - ON', 'in London, Ontario-based startups hiring']) {
    const p = placeIn(q)
    // either the intended London (refusing every UK posting) or a named reason the job boards could not place it, never a silent UK London
    // (a place written in lower case is skipped too; its reason is the general one, since the reason reads a capitalised place name)
    if (!p) { assert.match(placeSkipReason(q), /^[A-Z]/.test(q.replace(/^in /, '')) ? /^skipped_no_place:[a-z]+:/ : /^skipped_no_place/, `${q}: no place, so the job boards say why`); continue }
    for (const l of UK) assert.equal(p.ok(l), false, `${q} resolved to '${p.name}', which accepts the UK posting '${l}'`)
  }
  // the place a qualified London resolves to is that London, read by the resolver for its qualifier
  assert.equal(placeIn('in London, Indiana')?.name, 'London, IN')
  assert.equal(placeIn('in London, WV')?.name, 'London, WV')
  assert.equal(placeIn('in London, Alberta')?.ok('London, AB'), true)
  assert.equal(placeIn('in London, Alberta')?.ok('London, ON'), false, 'a London read from its province refuses another province')
  assert.equal(placeIn('in London, KY')?.ok('London, KY 40741'), true, 'a namesake London accepts a posting naming its own state')
  // the UK London is unchanged: bare, with a UK marker, or followed by words that are not a place
  for (const q of ['hiring sales staff in London', 'in London, UK', 'in London, England', 'London UK B2B SaaS startups hiring sales staff', 'in London, United Kingdom',
    'London-based fintechs hiring SDRs', 'in London, hiring account executives', 'in London, the startups hiring', 'in London, EC1A', 'in London, AI startups hiring', 'SaaS in London, US startups hiring', 'in London, UAE founders hiring', 'in London, Eng.', 'in London, in 2025 hiring', 'in London, NE1 4AB', 'London-based fintechs hiring', 'in London \u2013 hiring now',
    'fintechs in London, e.g. Monzo', 'in London, etc.', 'in London, St. Albans area', 'SaaS in London, Inc. 500 list', 'in London, Gt. Britain']) {
    const p = placeIn(q)
    assert.equal(p?.name, 'London', `${q} stays the UK London`)
    assert.equal(p!.ok('London, UK'), true, q)
    assert.equal(p!.ok('London, IN'), false, `${q} refuses London, IN`)
  }
})

test('#1205 the province data reads the "Ont" form of Ontario', () => {
  for (const f of ['Ont', 'ONT', 'Ont.']) assert.equal(regionOf(f), 'CA-on', f)
})

for (const where of ['London (Ontario)', 'London, Ky.']) {
  test(`#1205 runJob: a request for ${where} never reads a UK London posting: the job boards resolve no UK place and say why`, async () => {
    const { http, seen } = board()
    const x = await runFixture(fx(http, where))
    assert.equal(seen.filter(u => /boards-api\.greenhouse\.io/.test(u)).length, 0, 'no board was read for the UK London')
    const run = x.db.prepare("SELECT status FROM scan_source_runs WHERE collector = 'adapter:jobboards'").get() as { status: string }
    assert.match(run.status, /^skipped_no_place:[a-z]+:/, `a named reason: ${run.status}`)
    const qualified = x.leads.filter(l => !l.review_reason).map(l => l.source_url)
    for (const i of [0, 1, 3]) assert.ok(!qualified.includes(gh(i)), `UK posting '${LOCS[i]}' is not a qualified lead`)
  })
}

test('#1205 a profile in another country never takes the UK London for a bare "London"; a UK or unset profile keeps it', () => {
  for (const c of ['CA', 'Canada', 'US', 'United States', 'IE', 'DE', 'AU', 'IN', 'SG', 'Ireland', 'Irelnd', 'Georgia']) assert.equal(profilePlace('London', c), null, `a ${c} profile's bare London is not the UK's`)
  assert.equal(profilePlace('London, Ontario', 'CA')?.name, 'London', 'a Canadian profile naming its province keeps its London')
  assert.equal(placeIn('in London, Ontario')!.ok('London, UK'), false)
  for (const c of ['UK', 'United Kingdom', 'GB', 'England', 'Great Britain', '', null]) assert.equal(profilePlace('London', c)?.name, 'London', `${c} profile keeps the UK London`)
  assert.equal(profilePlace('New York City', 'US')?.name, 'New York City', 'a US profile keeps New York City')
  // only a BARE shared name is withheld: a place written with its country, or an unshared built-in city, stays whatever the profile's country
  for (const [w, c, name] of [['New York City', 'UK', 'New York City'], ['NYC', 'Germany', 'New York City'], ['Brooklyn', 'UK', 'New York City'],
    ['London, UK', 'US', 'London'], ['London, England', 'Canada', 'London']] as const) assert.equal(profilePlace(w, c)?.name, name, `${w} for a ${c} profile`)
  assert.equal(placeIn(`in ${profilePlace('London, UK', 'US')!.text}`)!.ok('London, UK'), true, 'a US profile naming London, UK gets UK postings')
})
