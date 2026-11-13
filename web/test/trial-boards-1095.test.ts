// #1095 (live staging free trial, 2026-11-13, jobs 3b417870 / 49a16547): a brand-new trial account asked
// "Austin B2B SaaS companies hiring their first account executive in the last 30 days". The profile resolved the place to "Austin, TX",
// but the free job-board source (Greenhouse / Lever / Ashby JSON: readable, dated postings) needs a place it recognises in the REQUEST,
// and a bare US city is neither London/NYC, a state name nor "<City>, <Country>". It was skipped ("skipped_no_place"), so the trial's
// only candidates were aggregator pages (LinkedIn, Indeed, Glassdoor, mediabistro, builtinaustin) and 0 leads were ready.
// REAL from that run: the request, the profile place, the planned queries, the result URLs and the candidates the model drew from them.
// INVENTED: the Greenhouse board JSON for Justworks (one of those real candidates) and its posting body.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture, type Cand } from './helpers/acceptance-harness.ts'
import type { SafeGet } from '../lib/sources/types.ts'
import { placeIn } from '../lib/sources/jobboards.ts'

const REQUEST = 'Austin B2B SaaS companies hiring their first account executive in the last 30 days'
const ICP = { summary: 'Austin B2B SaaS companies hiring their first account executive', who: ['Founder', 'CEO'], industries: ['B2B SaaS'], sizes: ['1-50'], where: ['Austin, TX'], signals: ['hiring their first account executive'], exclude: [], country: 'US', language: 'en', window_days: 30 }
const QUERIES = ['(site:boards.greenhouse.io OR site:job-boards.greenhouse.io) "first account executive" Austin, TX', 'Austin B2B SaaS first account executive hiring Austin, TX', 'Austin software company account executive job posting careers Austin, TX']
const LI = 'https://linkedin.com/jobs/view/account-executive-in-territory-austin-tx-at-justworks-4485363528'
const MEDIA = 'https://www.mediabistro.com/jobs/3543208051-saas-smb-account-executive-4-day-week-hybrid'
const GH_AUSTIN = 'https://job-boards.greenhouse.io/justworks/jobs/7301001'
const GH_DALLAS = 'https://job-boards.greenhouse.io/justworks/jobs/7301002'
const QUOTE = 'Justworks is hiring an Account Executive to own new business for small companies across Austin and Central Texas'
function boards() {
  const seen: string[] = []
  const http: SafeGet = async url => {
    if (new URL(url).hostname === 'hn.algolia.com') return null
    seen.push(url); const j = (o: unknown) => ({ status: 200, body: JSON.stringify(o) })
    if (url === 'https://boards-api.greenhouse.io/v1/boards/justworks/jobs') return j({ jobs: [
      { id: 7301001, title: 'Account Executive - In-Territory (Austin, TX)', updated_at: daysAgo(1), location: { name: 'Austin, TX' }, absolute_url: GH_AUSTIN },
      { id: 7301002, title: 'Account Executive - In-Territory (Dallas, TX)', updated_at: daysAgo(1), location: { name: 'Dallas, TX' }, absolute_url: GH_DALLAS },
    ] })
    const d = url.match(/boards\/justworks\/jobs\/(\d+)$/)
    if (d) return j({ id: +d[1], title: 'Account Executive - In-Territory', first_published: daysAgo(9), content: `&lt;p&gt;${QUOTE}.&lt;/p&gt;&lt;p&gt;You will run the full sales cycle from first call to signed contract with founders and finance leaders.&lt;/p&gt;`, location: { name: d[1] === '7301001' ? 'Austin, TX' : 'Dallas, TX' }, absolute_url: d[1] === '7301001' ? GH_AUSTIN : GH_DALLAS })
    return null
  }
  return { http, seen }
}
function fx(sourceHttp: SafeGet): Fixture {
  // The model's candidates: from the search (REAL: Justworks on LinkedIn, OEC on mediabistro) and, when the board posting is in its
  // prompt, from the posting (quoting the posting's own text).
  const fromSearch: Cand[] = [
    { company: 'Justworks', signal: 'Justworks is hiring an Account Executive in Austin, TX', source_url: LI, excerpt: 'Account Executive - In-Territory (Austin, TX)', event_date: daysAgo(9) },
    { company: 'OEC', signal: 'is hiring a SaaS SMB account executive', source_url: MEDIA, excerpt: 'OEC is seeking a SaaS SMB Account Executive to drive the full sales cycle', event_date: null as never },
  ]
  return {
    request: REQUEST, modelIcp: ICP, modelQueries: QUERIES,
    hits: [{ url: LI, title: 'Account Executive - In-Territory (Austin, TX) at Justworks', snippet: 'Justworks Account Executive Austin, TX', date: daysAgo(9) }, { url: MEDIA, title: 'SaaS SMB Account Executive', snippet: 'OEC is seeking a SaaS SMB Account Executive', date: null as never }],
    // the verifier reads a Greenhouse posting through its board API record (lib/sources/ats-posting.ts): its title line, then its own text
    tfPages: {}, own: { [LI]: 'blocked', [MEDIA]: 'blocked', [GH_AUSTIN]: { title: 'Account Executive - In-Territory @ justworks', text: `Account Executive - In-Territory Austin, TX ${QUOTE}. You will run the full sales cycle from first call to signed contract with founders and finance leaders. Job posting on the Greenhouse job board.`, published: daysAgo(9).slice(0, 10) } },
    extraction: fromSearch,
    extractionFn: p => p.includes('"source":"jobboards"') && p.includes(GH_AUSTIN)
      ? [...fromSearch, { company: 'Justworks', signal: 'hiring an Account Executive in Austin, TX', source_url: GH_AUSTIN, excerpt: QUOTE, event_date: daysAgo(9) }]
      : fromSearch,
    deps: { sourceHttp },
  }
}

test('#1095: a US "<City>, <ST>" is a place for the job-board source; it never widens to the state or matches remote', () => {
  const p = placeIn('in Austin, TX')
  assert.equal(p?.name, 'Austin, TX')
  assert.deepEqual([p!.ok('Austin, TX'), p!.ok('Hybrid - Austin, Texas'), p!.ok('Dallas, TX'), p!.ok('Austin, MN'), p!.ok('Remote')], [true, true, false, false, false])
  assert.equal(placeIn('Portland, Oregon')?.name, 'Portland, OR')
  // a non-US country, another state (read without the city's own words: Kansas City, MO names no Kansas) and a remote posting are never the city
  const sj = placeIn('in San Jose, CA')!
  assert.deepEqual([sj.ok('San Jose, CA'), sj.ok('San Jose, California, United States'), sj.ok('San Jose, Costa Rica')], [true, true, false])
  const kc = placeIn('in Kansas City, MO')!
  assert.deepEqual([kc.ok('Kansas City, MO'), kc.ok('Kansas City, KS')], [true, false])
  assert.deepEqual([p!.ok('Austin'), p!.ok('Austin, US'), p!.ok('Austin, TX HQ'), p!.ok('Remote - Austin, TX')], [true, true, true, false], 'the real board location shapes (Braze, Dialpad, AlertMedia) match; remote does not')
  assert.equal(placeIn(REQUEST), null, 'the request alone names no place the source knows: the profile supplies it')
  // review on #1155: a role or request word right before the city is not part of it (else the place matched nothing and blocked the state / profile fallbacks)
  for (const [q, city, loc] of [['Account Executive Austin, TX', 'Austin, TX', 'Austin, TX'], ['Sales Manager Dallas, Texas', 'Dallas, TX', 'Dallas, TX'], ['Companies hiring AEs. Austin, TX', 'Austin, TX', 'Austin, Texas'], ['St. Louis, MO sales', 'St. Louis, MO', 'St. Louis, MO'], ['Salt Lake City, UT', 'Salt Lake City, UT', 'Salt Lake City, UT']] as const) {
    const pl = placeIn(q); assert.equal(pl?.name, city, q); assert.equal(pl!.ok(loc), true, `${q} matches ${loc}`)
  }
  // a role word before ", <State>" is not a city: the request keeps its state place (review round 2 on #1155); a "New ..." city keeps its name
  for (const q of ['Sales Manager, Texas', 'Account Executive, Texas', 'Founders, Texas']) assert.equal(placeIn(q)?.name, 'Texas', q)
  assert.equal(placeIn('SDR Team Lead, California')?.name, 'California')
  assert.equal(placeIn('in New Orleans, LA')?.name, 'New Orleans, LA')
})

test('#1095 review: a profile naming SEVERAL places is never narrowed to its first one: the board source says it had no place', async () => {
  const { http, seen } = boards()
  const f = fx(http); f.modelIcp = { ...ICP, where: ['Austin, TX', 'Boston, MA'] }
  const x = await runFixture(f)
  const run = x.db.prepare("SELECT status FROM scan_source_runs WHERE collector = 'adapter:jobboards'").get() as { status: string } | undefined
  assert.equal(run?.status, 'skipped_no_place')
  assert.ok(!seen.some(u => u.includes('greenhouse')), 'no board was read')
})

test('#1095 live trial request: the profile\'s "Austin, TX" runs the free job-board source, the Austin posting becomes a verified, board-dated lead, and the Dallas posting never reaches extraction', async () => {
  const { http, seen } = boards()
  const x = await runFixture(fx(http))
  const run = x.db.prepare("SELECT status FROM scan_source_runs WHERE collector = 'adapter:jobboards'").get() as { status: string } | undefined
  assert.ok(run && ['ok', 'partial'].includes(run.status), `the job-board source ran: ${run?.status}`)
  assert.ok(seen.includes('https://boards-api.greenhouse.io/v1/boards/justworks/jobs'), 'the board of a company this scan found was read')
  assert.ok(!seen.some(u => u.endsWith('/7301002')), 'the Dallas posting was never detail-fetched')
  const ready = x.leads.filter(l => !l.review_reason)
  const gh = ready.find(l => l.source_url === GH_AUSTIN)
  assert.ok(gh, `a ready lead cites the Austin posting: ${JSON.stringify(x.leads.map(l => [l.company, l.source_url, l.review_reason]))}`)
  assert.equal(gh!.event_date, daysAgo(9).slice(0, 10), 'dated by the board\'s own first-published day')
})
