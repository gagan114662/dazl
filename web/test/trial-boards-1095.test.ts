// #1095 (live staging free trial, 2026-11-13, jobs 3b417870 / 49a16547): a brand-new trial account asked
// "Austin B2B SaaS companies hiring their first account executive in the last 30 days". The profile resolved the place to "Austin, TX",
// but the free job-board source (Greenhouse / Lever / Ashby JSON: readable, dated postings) needs a place it recognises in the REQUEST,
// and a bare US city is neither London/NYC, a state name nor "<City>, <Country>". It was skipped ("skipped_no_place"), so the trial's
// only candidates were aggregator pages (LinkedIn, Indeed, Glassdoor, mediabistro, builtinaustin) and 0 leads were ready.
// REAL from that run: the request, the profile place, the planned queries, the result URLs and the candidates the model drew from them
// (NinjaOne on thesaasjobs, OEC on mediabistro: both held, 0 ready).
// REAL, verbatim (review at 54953a0a: no invented posting): the Greenhouse board of NinjaOne as its public API returned it on 2026-11-13
// (test/fixtures/1095-ninjaone-greenhouse.json: all 21 postings titled Account Executive, the three Austin ones in full). Only the dates are
// moved: each posting keeps its age as of 2026-11-13, so the 30-day window reads the same on any day the test runs.
// SYNTHETIC: the model's replies. Its candidate for the board posting quotes the sentence the source itself handed it (company boilerplate,
// as on every real posting read: the vacancy is proven by the record's title, never by that sentence).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runFixture, type Fixture, type Cand } from './helpers/acceptance-harness.ts'
import type { SafeGet } from '../lib/sources/types.ts'
import { placeIn, profilePlaceText, bareUsCity } from '../lib/sources/jobboards.ts'
import { ADAPTERS } from '../lib/sources/index.ts'
import { atsPostingRef, atsRecord, atsPageText } from '../lib/sources/ats-posting.ts'
import { htmlToText, decode } from '../lib/scan/fetch-page.ts'
import { enrichmentsForLeads } from '../lib/connectors/store.ts'

const REQUEST = 'Austin B2B SaaS companies hiring their first account executive in the last 30 days'
const ICP = { summary: 'Austin B2B SaaS companies hiring their first account executive', who: ['Founder', 'CEO'], industries: ['B2B SaaS'], sizes: ['1-50'], where: ['Austin, TX'], signals: ['hiring their first account executive'], exclude: [], country: 'US', language: 'en', window_days: 30 }
const QUERIES = ['(site:boards.greenhouse.io OR site:job-boards.greenhouse.io) "first account executive" Austin, TX', 'Austin B2B SaaS first account executive hiring Austin, TX', 'Austin software company account executive job posting careers Austin, TX']
const SAASJOBS = 'https://www.thesaasjobs.com/jobs/767593187-account-executive-mid-market-midwest'
const MEDIA = 'https://www.mediabistro.com/jobs/3543208051-saas-smb-account-executive-4-day-week-hybrid'
const GH = (id: number | string) => `https://job-boards.greenhouse.io/ninjaone/jobs/${id}`
const AUSTIN = [4472362009, 4469783009, 4470849009]   // Account Executive, MSP / Account Executive, SMB / SLED Senior Account Executive, Mid Market
type GhJob = { id: number; title: string; first_published: string; updated_at: string; location: { name: string }; content?: string }
const REAL = JSON.parse(readFileSync(new URL('./fixtures/1095-ninjaone-greenhouse.json', import.meta.url), 'utf8')) as { list: { jobs: GhJob[] }; postings: Record<string, GhJob> }
// the record's own dates, moved by the days since the fixture was read (2026-11-13)
const READ = Date.UTC(2026, 10, 13)
const moved = (iso: string) => new Date(Date.parse(iso) + (Math.floor(Date.now() / 86_400_000) * 86_400_000 - READ)).toISOString()
const live = <T extends GhJob>(j: T): T => ({ ...j, first_published: moved(j.first_published), updated_at: moved(j.updated_at) })
function boards() {
  const seen: string[] = []
  const http: SafeGet = async url => {
    if (new URL(url).hostname === 'hn.algolia.com') return null
    seen.push(url); const j = (o: unknown) => ({ status: 200, body: JSON.stringify(o) })
    if (url === 'https://boards-api.greenhouse.io/v1/boards/ninjaone/jobs') return j({ ...REAL.list, jobs: REAL.list.jobs.map(live) })
    const d = url.match(/boards\/ninjaone\/jobs\/(\d+)$/)
    if (d && REAL.postings[d[1]]) return j(live(REAL.postings[d[1]]))
    return null
  }
  return { http, seen }
}
// The verifier's read of a posting URL, built by the real code from the real record (lib/scan/fetch-page.ts does exactly this with the API body).
const fetchPage = async (u: string) => {
  const ref = atsPostingRef(u), raw = ref?.org === 'ninjaone' ? REAL.postings[ref.id] : null
  if (!ref || !raw) return { fail: 'blocked' as const }   // the aggregator pages (thesaasjobs, mediabistro) were not readable in the live run either
  const rec = atsRecord(live(raw), ref)
  if (!rec || rec === 'missing') return { fail: 'error' as const }
  const page = atsPageText(rec, rec.html ? htmlToText(decode(rec.description)).text : rec.description)
  return { text: page.text, title: page.title, board: page.board, retrievedAt: Math.floor(Date.now() / 1000), published: rec.posted, postedAt: rec.posted, structured: [] }
}
function fx(sourceHttp: SafeGet): Fixture {
  // The model's candidates: from the search (REAL: NinjaOne on thesaasjobs, OEC on mediabistro) and, for each board posting in its prompt,
  // one that cites the posting and quotes the sentence the source handed over.
  const fromSearch: Cand[] = [
    { company: 'NinjaOne', signal: 'is hiring an account executive', source_url: SAASJOBS, excerpt: 'The Account Executive role at NinjaOne, is responsible for achieving sales and profitability objectives among our largest and most strategic prospect accounts.', event_date: null as never },
    { company: 'OEC', signal: 'is hiring a SaaS SMB account executive', source_url: MEDIA, excerpt: 'OEC is seeking a SaaS SMB Account Executive to drive the full sales cycle', event_date: null as never },
  ]
  return {
    request: REQUEST, modelIcp: ICP, modelQueries: QUERIES,
    hits: [{ url: SAASJOBS, title: 'Account Executive, Mid Market Midwest', snippet: 'The Account Executive role at NinjaOne', date: null as never }, { url: MEDIA, title: 'SaaS SMB Account Executive', snippet: 'OEC is seeking a SaaS SMB Account Executive', date: null as never }],
    tfPages: {}, own: {},
    extraction: fromSearch,
    extractionFn: p => {
      const out = [...fromSearch]
      for (const m of p.matchAll(/\{[^{}]*"source":"jobboards"[^{}]*\}/g)) {
        const it = JSON.parse(m[0]) as { url: string; text: string; date?: string }
        out.push({ company: 'NinjaOne', signal: 'is hiring an account executive in Austin, TX', source_url: it.url, excerpt: it.text, event_date: it.date ?? (null as never) })
      }
      return out
    },
    deps: { sourceHttp, fetchPage },
  }
}

test('#1095: a US "<City>, <ST>" after in / near / around is a place for the job-board source; it never widens to the state or matches remote', () => {
  const p = placeIn('in Austin, TX')
  assert.equal(p?.name, 'Austin, TX')
  assert.deepEqual([p!.ok('Austin, TX'), p!.ok('Hybrid - Austin, Texas'), p!.ok('Dallas, TX'), p!.ok('Austin, MN'), p!.ok('Remote')], [true, true, false, false, false])
  assert.equal(placeIn('SaaS companies near Portland, Oregon hiring AEs')?.name, 'Portland, OR')
  // a non-US country, another state (read without the city's own words: Kansas City, MO names no Kansas) and a remote posting are never the city
  const sj = placeIn('in San Jose, CA')!
  assert.deepEqual([sj.ok('San Jose, CA'), sj.ok('San Jose, California, United States'), sj.ok('San Jose, Costa Rica')], [true, true, false])
  const kc = placeIn('in Kansas City, MO')!
  assert.deepEqual([kc.ok('Kansas City, MO'), kc.ok('Kansas City, KS')], [true, false])
  assert.deepEqual([p!.ok('Austin'), p!.ok('Austin, US'), p!.ok('Austin, TX HQ'), p!.ok('Austin, Texas, United States'), p!.ok('Remote - Austin, TX'), p!.ok('Texas, USA')], [true, true, true, true, false, false], 'the real board location shapes (Braze, Dialpad, AlertMedia, NinjaOne) match; remote and a state-only location do not')
  assert.equal(placeIn(REQUEST), null, 'the request alone names no place the source knows: the profile supplies it')
  for (const [q, city] of [['account executives in Austin, TX', 'Austin, TX'], ['dentists in Columbus, OH hiring', 'Columbus, OH'], ['in St. Louis, MO', 'St. Louis, MO'], ['around Salt Lake City, UT', 'Salt Lake City, UT'], ['in New Orleans, LA', 'New Orleans, LA']] as const) assert.equal(placeIn(q)?.name, city, q)
  assert.equal(placeIn(`${REQUEST} in Austin, TX`)?.name, 'Austin, TX', 'the request as the board source reads it (the profile place appended)')
})

test('#1095 review at 54953a0a: a capitalised phrase before ", <State>" is not a city: the request keeps the state place it has on main', () => {
  for (const [q, state] of [
    ['Dentists, Ohio hiring a receptionist', 'Ohio'], ['Restaurants, Texas hiring sales staff', 'Texas'], ['Healthcare Providers, Florida hiring SDRs', 'Florida'],
    ['Series B Fintechs, California hiring account executives', 'California'], ['Sales Manager, Texas', 'Texas'], ['SDR Team Lead, California', 'California'], ['Portland, Oregon', 'Oregon'],
  ] as const) {
    const pl = placeIn(q); assert.equal(pl?.name, state, q)
    assert.equal(pl!.ok(`Somewhere, ${state}`), true, `${q} reads the state's postings`)
  }
  assert.equal(placeIn('SDRs in Remote, CA'), null, 'Remote is never a city')
  // review at 910ebe60: a request naming two cities is not narrowed to the first (main: no place)
  assert.equal(placeIn('account executives in Austin, TX and in Dallas, TX'), null)
  assert.equal(placeIn('in Austin, TX and Dallas, TX'), null)
  for (const q of ['in Austin, TX, Dallas, TX', 'in Austin, TX; Dallas, TX', 'in Austin, TX / Dallas, TX', 'in Austin, TX & Dallas, TX', 'in Austin, TX or Dallas, TX']) assert.equal(placeIn(q), null, q)
  for (const q of ['in Austin, TX, United States', 'account executives in Austin, TX, hiring now', 'in Austin, TX; remote is fine']) assert.equal(placeIn(q)?.name, 'Austin, TX', q)
  assert.equal(placeIn('in Austin, TX or near Austin, TX')?.name, 'Austin, TX', 'the same city twice is one place')
})

test('#1095 review: a profile naming SEVERAL places is never narrowed to its first one: the board source says it had no place', async () => {
  const { http, seen } = boards()
  const f = fx(http); f.modelIcp = { ...ICP, where: ['Austin, TX', 'Boston, MA'] }
  const x = await runFixture(f)
  const run = x.db.prepare("SELECT status FROM scan_source_runs WHERE collector = 'adapter:jobboards'").get() as { status: string } | undefined
  assert.equal(run?.status, 'skipped_no_place')
  assert.ok(!seen.some(u => u.includes('greenhouse')), 'no board was read')
})

test('#1095 live trial request on the REAL NinjaOne board: the profile\'s "Austin, TX" runs the free job-board source and an Austin posting becomes a source-checked, board-dated lead with its hiring row', async () => {
  const { http, seen } = boards()
  const x = await runFixture(fx(http))
  const run = x.db.prepare("SELECT status FROM scan_source_runs WHERE collector = 'adapter:jobboards'").get() as { status: string } | undefined
  assert.ok(run && ['ok', 'partial'].includes(run.status), `the job-board source ran: ${run?.status}`)
  assert.ok(seen.includes('https://boards-api.greenhouse.io/v1/boards/ninjaone/jobs'), 'the board of a company this scan found was read')
  const details = seen.filter(u => /\/jobs\/\d+$/.test(u)).map(u => +u.split('/').pop()!)
  assert.ok(details.length > 0 && details.every(id => AUSTIN.includes(id)), `only Austin postings were detail-fetched (not "Texas, USA", Singapore, Germany ...): ${details}`)
  const checked = x.leads.filter(l => !l.review_reason)
  const gh = checked.find(l => AUSTIN.some(id => l.source_url === GH(id)))
  assert.ok(gh, `a source-checked lead (no review reason) cites an Austin NinjaOne posting: ${JSON.stringify(x.leads.map(l => [l.company, l.source_url, l.review_reason]))}`)
  const id = gh!.source_url.split('/').pop()!
  assert.equal(gh!.event_date, moved(REAL.postings[id].first_published).slice(0, 10), 'dated by the board\'s own first-published day')
  // the vacancy is the record's TITLE; the stored quote is the posting's own (boilerplate) sentence
  const row = x.db.prepare('SELECT l.id, j.user_id FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.source_url = ?').get(gh!.source_url) as { id: string; user_id: string }
  const rows = (enrichmentsForLeads(x.db, row.user_id, [row.id])[row.id] ?? []).filter(e => e.kind === 'hiring')
  assert.equal(rows.length, 1, 'one hiring row for the posting')
  assert.ok(rows[0].value.includes(REAL.postings[id].title.trim()), `the hiring row names the record's title: ${rows[0].value}`)
  assert.equal(rows[0].source_url, gh!.source_url)
})

test('#1095 XHawk: when the user PICKED the job boards as a source, the profile place still drives them (same request, same board)', async () => {
  const { http, seen } = boards()
  const f = fx(http); f.sources = JSON.stringify({ adapters: ['jobboards'], feeds: [], pages: [] })
  const x = await runFixture(f)
  const run = x.db.prepare("SELECT status FROM scan_source_runs WHERE collector = 'adapter:jobboards'").get() as { status: string } | undefined
  assert.ok(run && ['ok', 'partial'].includes(run.status), `the picked board source ran with the profile place: ${run?.status}`)
  assert.ok(seen.includes('https://boards-api.greenhouse.io/v1/boards/ninjaone/jobs'), 'the board was read')
})

test('#1095 XHawk: with job boards PLUS another picked source, only the board source reads the request with the place appended', async () => {
  const { http, seen } = boards()
  const real = ADAPTERS.github.collect; const asked: string[] = []
  ADAPTERS.github.collect = async input => { asked.push(input.query); return [] }
  try {
    const f = fx(http); f.sources = JSON.stringify({ adapters: ['jobboards', 'github'], feeds: [], pages: [] })
    await runFixture(f)
  } finally { ADAPTERS.github.collect = real }
  assert.deepEqual(asked, [REQUEST], 'the other source got the user\'s own request')
  assert.ok(seen.includes('https://boards-api.greenhouse.io/v1/boards/ninjaone/jobs'), 'the board source still read the Austin board')
})

// LIVE CHECK FAILED on the merged #1155 (staging d1cb4970, 2026-11-13): the trial scan recorded adapter:jobboards = skipped_no_place. The profile dazl
// INFERRED for a brand-new trial account stored its place WITHOUT a state, and the profile-place fallback only kept a place placeIn resolves
// ("in Austin" names no place; "in Austin, TX" does). #1155's own tests and proof all used "Austin, TX": that gap was the bug.
// REAL: this is the profile of job 64a0f578 verbatim (staging scan_jobs.icp), and the request of that job.
const REAL_STAGING_ICP = JSON.parse('{"summary":"B2B SaaS companies in Austin that have hired their first account executive in the last 30 days.","who":["Founder","CEO","VP Sales","Head of Sales","Chief Revenue Officer","VP Revenue"],"industries":["B2B SaaS","Enterprise Software","Cloud Software","Business Software"],"sizes":["1-10 employees","11-50 employees"],"where":["Austin"],"signals":["Hired first account executive in last 30 days","First sales hire","New account executive job posting filled","Sales team expansion from zero","First AE hire"],"exclude":["B2C companies","Non-SaaS companies","Companies with existing account executives before 30 days ago"],"country":"US","language":"en","window_days":30}')

test('#1095 live check: the profile the staging trial account was actually given (where ["Austin"], no state, country "US") runs the free job-board source, and the board postings reach verification dated by their board', async () => {
  const { http, seen } = boards()
  const f = fx(http); f.modelIcp = REAL_STAGING_ICP
  const x = await runFixture(f)
  const run = x.db.prepare("SELECT status FROM scan_source_runs WHERE collector = 'adapter:jobboards'").get() as { status: string } | undefined
  assert.ok(run && ['ok', 'partial'].includes(run.status), `the job-board source ran (it was skipped_no_place on staging): ${run?.status}`)
  assert.ok(seen.includes('https://boards-api.greenhouse.io/v1/boards/ninjaone/jobs'), 'the board of a company this scan found was read')
  const posting = x.leads.find(l => AUSTIN.some(id => l.source_url === GH(id)))
  assert.ok(posting, `an Austin NinjaOne posting is a candidate that reached verification: ${JSON.stringify(x.leads.map(l => [l.company, l.source_url, l.review_reason]))}`)
  assert.equal(posting!.event_date, moved(REAL.postings[posting!.source_url.split('/').pop()!].first_published).slice(0, 10), 'dated by the board\'s own first-published day')
  // NOT asserted here, and a second real finding of the same live check: this profile's signals include "Sales team expansion from zero", which the
  // sales-hiring gate reads as an event BEYOND hiring, so such a posting is held no_event_evidence (see the next test, and the issue filed for it)
})

test('#1095 live check: the same real profile without its one expansion signal gives a source-checked lead (the expansion signal is a separate cause, tracked in its own issue)', async () => {
  const noExpansion = { ...REAL_STAGING_ICP, signals: (REAL_STAGING_ICP.signals as string[]).filter(sg => !/expansion/i.test(sg)) }
  const a = boards(); const fa = fx(a.http); fa.modelIcp = noExpansion
  const xa = await runFixture(fa)
  const ok = xa.leads.filter(l => !l.review_reason).find(l => AUSTIN.some(id => l.source_url === GH(id)))
  assert.ok(ok, `a source-checked lead (no review reason) cites an Austin NinjaOne posting: ${JSON.stringify(xa.leads.map(l => [l.company, l.source_url, l.review_reason]))}`)
  // (with the expansion signal the lead is held no_event_evidence today: the issue filed for that decides what the gate should do; this test does not pin it)
})

test('#1095 live check: a bare US city of a US profile resolves to its most populous place; an ambiguous name, a non-US profile and a phrase name no place', () => {
  assert.equal(profilePlaceText('Austin', 'US'), 'Austin, TX', 'Austin TX 974,447 against Austin MN 26,208')
  for (const [w, want] of [['Portland', 'Portland, OR'], ['Columbus', 'Columbus, OH'], ['Cambridge', 'Cambridge, MA'], ['Boise', 'Boise, ID'], ['Nashville', 'Nashville, TN'], ['Louisville', 'Louisville, KY'], ['St. Louis', 'St. Louis, MO'], ['San Jose', 'San Jose, CA']] as const) assert.equal(profilePlaceText(w, 'US'), want, w)
  assert.equal(profilePlaceText('Springfield', 'US'), null, 'Springfield is MO 170,067 / MA 154,064 / IL 113,273: ambiguous, so no place rather than the wrong one')
  assert.equal(profilePlaceText('Austin', undefined), null, 'a profile that does not say it is US is not guessed')
  assert.equal(profilePlaceText('Austin', 'GB'), null)
  for (const w of ['Fintech', 'Greater Austin', 'San Francisco Bay Area', 'Remote', 'Austin and Dallas', 'austin']) assert.equal(profilePlaceText(w, 'US'), null, w)
  // entries that already resolve are unchanged, with or without a country
  assert.deepEqual(['Austin, TX', 'Austin, Texas', 'Texas', 'London'].map(w => profilePlaceText(w, undefined)), ['Austin, TX', 'Austin, TX', 'Texas', 'London'])
  assert.equal(bareUsCity('Austin')?.abbr, 'TX')
  // the text it returns is one placeIn resolves, so the request the board source reads names the place
  assert.equal(placeIn(`${REQUEST} in ${profilePlaceText('Austin', 'US')}`)?.name, 'Austin, TX')
})

test('#1095 review: a profile naming a city AND its state is one place; "U.S." is a US country; a different state still makes two places', async () => {
  const { absorbStates } = await import('../lib/sources/jobboards.ts')
  assert.deepEqual(absorbStates(['Austin, TX', 'Texas']), ['Austin, TX'])
  assert.deepEqual(absorbStates(['Austin, TX', 'Florida']), ['Austin, TX', 'Florida'], 'another state is another place')
  assert.deepEqual(absorbStates(['Texas']), ['Texas'])
  assert.equal(profilePlaceText('Austin', 'U.S.'), 'Austin, TX'); assert.equal(profilePlaceText('Austin', ' usa '), 'Austin, TX')
  const { http, seen } = boards()
  const f = fx(http); f.modelIcp = { ...REAL_STAGING_ICP, where: ['Austin', 'Texas'] }
  await runFixture(f)
  assert.ok(seen.includes('https://boards-api.greenhouse.io/v1/boards/ninjaone/jobs'), 'where ["Austin","Texas"] runs the board source for Austin, TX')
})

test('#1095 live check: two profile entries naming the same place are one place; two different places still name none', async () => {
  const { http, seen } = boards()
  const same = fx(http); same.modelIcp = { ...REAL_STAGING_ICP, where: ['Austin', 'Austin, TX'] }
  await runFixture(same)
  assert.ok(seen.includes('https://boards-api.greenhouse.io/v1/boards/ninjaone/jobs'), 'Austin and Austin, TX are one place')
  const two = boards(); const f2 = fx(two.http); f2.modelIcp = { ...REAL_STAGING_ICP, where: ['Austin', 'Boston'] }
  const x = await runFixture(f2)
  assert.equal((x.db.prepare("SELECT status FROM scan_source_runs WHERE collector = 'adapter:jobboards'").get() as { status: string } | undefined)?.status, 'skipped_no_place')
  assert.ok(!two.seen.some(u => u.includes('greenhouse')))
})
