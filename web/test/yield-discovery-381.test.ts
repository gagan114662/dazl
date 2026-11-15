// #381 / #685 yield, step 2 (stacked on #1212): discovery. REAL data: test/fixtures/yield-381-matrix-20261113.json (the 7 staging matrix scans of 2026-11-13: requests,
// profiles, the queries sent, every result URL with its fetch selection, every candidate with its fate) and the 8 matrix requests. A live probe showed -site:
// exclusions work on the search provider (~/work/verify/yield/exclusion-probe-20261114.txt on the builder PC). SYNTHETIC parts are marked where they appear.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { eventQueries, hiringQueryForNonHiringRequest, requestAsksHiring } from '../lib/search/direct-queries.ts'
import { withExclusions, pickFetchUrls, isLoginWalled, QUERY_CAP } from '../lib/search/tinyfish.ts'
import { fetchRankFor, oneReadPerStory, pageKindRank, pagesAskHiring } from '../lib/scan/runner.ts'
import { planRetry } from '../lib/scan/retry-plan.ts'

interface Job { job: string; query: string; icp: { where: string[]; signals: string[] }; queries: string[]; urls: { url: string; selected: boolean }[]; candidates: { company: string; url: string; fate: string }[] }
const REAL = JSON.parse(readFileSync(new URL('./fixtures/yield-381-matrix-20261113.json', import.meta.url), 'utf8')) as { jobs: Job[] }
const job = (word: string) => REAL.jobs.find(j => j.query.startsWith(word))!

test('#381 exclusions: every open query excludes the hosts that can never be read; a site: target query, a host the request names and the search cap are respected', () => {
  const [open, board] = withExclusions(['Chicago law firm opens new office press release', '(site:boards.greenhouse.io OR site:job-boards.greenhouse.io) "estimators" Austin, Texas'], 'Law firms in Chicago')
  assert.equal(open, 'Chicago law firm opens new office press release -site:facebook.com -site:instagram.com -site:linkedin.com -site:youtube.com -site:tiktok.com')
  assert.equal(board, '(site:boards.greenhouse.io OR site:job-boards.greenhouse.io) "estimators" Austin, Texas', 'a query bound to its own hosts is left alone')
  assert.doesNotMatch(withExclusions(['agency posts about outbound'], 'Marketing agencies posting on LinkedIn about outbound')[0], /-site:linkedin\.com/, 'the user asked for LinkedIn')
  assert.match(withExclusions(['agency posts about outbound'], 'Marketing agencies posting on LinkedIn about outbound')[0], /-site:facebook\.com/)
  const long = 'x'.repeat(QUERY_CAP - 30)
  const out = withExclusions([long], 'r')[0]; assert.ok(out.length <= QUERY_CAP && out.startsWith(long), 'never cut, never over the cap')
  assert.equal(withExclusions([open], 'Law firms in Chicago')[0], open, 'applied once')
  // the real walled share this removes: 39 of the 178 real results
  const all = REAL.jobs.flatMap(j => j.urls)
  assert.equal(all.length, 178); assert.equal(all.filter(u => isLoginWalled(u.url)).length, 39)
})

test('#381 event queries: built from the request\'s own first sentence, one per event it names; instructions never become search words', () => {
  assert.deepEqual(eventQueries(job('Law').query).slice(0, 2), ['Law firms in Chicago, Illinois opened a new office announcement', 'Law firms in Chicago, Illinois expanded a practice group announcement'])
  assert.equal(eventQueries(job('Fintech').query)[0], 'Fintech startups in Berlin, Germany raised a funding round announcement')
  assert.equal(eventQueries(job('Restaurants').query)[0], 'Restaurants in Vancouver, British Columbia opening a second location announcement')
  assert.deepEqual(eventQueries(job('Marketing').query), [], 'a request with no "that ..." clause gets none')
  // the NYC acceptance request (instructions after the first sentence) and a "Find ..." opening
  const nyc = eventQueries('Find independent dental practices in New York City that posted a front desk receptionist job. Exclude chains and software vendors. Provide dated source evidence and a practice manager contact.')
  assert.equal(nyc[0], 'independent dental practices in New York City posted a front desk receptionist job announcement')
  for (const q of nyc) assert.doesNotMatch(q, /exclude|provide|evidence|contact|^find/i, q)
})

test('#381 a model query about hiring is dropped only when the request never asked for hiring (the real Berlin query); a hiring request keeps its hiring queries', () => {
  const berlin = job('Fintech'), hiringQ = berlin.queries.find(q => /hiring CTO/.test(q))!
  assert.equal(hiringQueryForNonHiringRequest(hiringQ, berlin.query), true, hiringQ)
  assert.equal(hiringQueryForNonHiringRequest(berlin.queries.find(q => /raised funding/.test(q))!, berlin.query), false)
  const austin = job('Roofing')
  for (const q of austin.queries) assert.equal(hiringQueryForNonHiringRequest(q, austin.query), false, q)
  assert.equal(hiringQueryForNonHiringRequest('Berliner Fintech stellt CTO ein jobs', berlin.query, 'de'), false, 'another language: left to the model')
})

test('#381 page reads go to pages that report an event: on the real Chicago result list the 4 slots took 2 government pages and a legal non-profit; now they take the firms\' own news pages', () => {
  const chicago = job('Law')
  const before = chicago.urls.filter(u => u.selected).map(u => new URL(u.url).hostname.replace(/^www\./, ''))
  assert.deepEqual(before, ['illinoisattorneygeneral.gov', 'illinois.gov', 'milbank.com', 'aclu-il.org'], 'what staging read (recorded)')
  const hits = new Map(chicago.urls.map(u => [u.url, { date: null, title: '' }]))   // the real results carried no date; titles were not stored
  const picked = pickFetchUrls(chicago.urls.map(u => u.url), 4, fetchRankFor(hits, 90, false, undefined, false))   // the request asks for no hiring
  const eventish = picked.filter(u => pageKindRank(u) === 0)
  assert.equal(eventish.length, 4, `all four slots go to event-looking pages: ${picked.join(' | ')}`)
  assert.ok(!picked.some(u => /greenhouse\.io|aclu-il\.org/.test(u)), `no unrelated job posting or non-profit page takes a slot: ${picked.join(' | ')}`)
  assert.ok(picked.filter(u => /\/news\/|press/.test(u)).length >= 3, picked.join(' | '))
  // kinds, on real addresses of the fixture
  assert.equal(pageKindRank('https://www.milbank.com/en/news/milbank-to-open-chicago-office.html'), 0)
  assert.equal(pageKindRank('https://smilecitydental.ca/'), 0.6, 'a home page')
  assert.equal(pageKindRank('https://dentix24.com/en/locations/'), 0.3)
  assert.equal(pageKindRank('https://job-boards.greenhouse.io/clutch/jobs/6255161004'), 0.3, 'a job posting is neutral for a hiring request (search order decides, as before)')
  assert.equal(pageKindRank('https://job-boards.greenhouse.io/clutch/jobs/6255161004', '', false), 0.6, 'and the least useful readable page for any other request')
  assert.equal(pageKindRank('https://example.com/x', 'Acme opens a second location in Vancouver'), 0, 'an event word in the title')
  // walled pages stay last, whatever they look like
  assert.equal(fetchRankFor(new Map(), 90, false)('https://www.facebook.com/TDOTDENTAL/posts/big-news-opening'), 8)
})

test('#685 the extra round looks for ANOTHER source of a company whose only source was blocked or unconfirmed (the real Toronto candidates), the unreadable host excluded', () => {
  const t = job('Dental')
  const review = t.candidates.map(c => ({ reason: c.fate.replace(/^review:/, ''), url: c.url, company: c.company }))
  const plan = planRetry(t.query, t.icp, { index: 0, verified: 0, queries: t.queries, hitsUniqueUrls: t.urls.length, dropReasons: {}, review })
  assert.equal(plan.retry, true)
  assert.equal(plan.queries.length, 3, 'the round keeps its 3 queries')
  assert.equal(plan.queries[0], '"TDot Dental" news announcement Toronto, Ontario -site:instagram.com')
  // (review) fresh profile signals keep most of the round: with two or more of them ONE company is retried
  assert.ok(plan.queries.slice(1).every(q => !q.startsWith('"')), `the other two are profile signals: ${JSON.stringify(plan.queries)}`)
  // with no fresh signal the slots would be empty: two companies are retried (and the round still runs)
  const none = planRetry(t.query, { ...t.icp, signals: [] }, { index: 0, verified: 0, queries: t.queries, hitsUniqueUrls: t.urls.length, dropReasons: {}, review })
  assert.equal(none.retry, true)
  assert.equal(none.queries.length, 2); assert.match(none.queries[1], /^"Orthodontics on Yonge" news announcement/, none.queries[1])
  // without company names (older callers) the plan is what it was
  const old = planRetry(t.query, t.icp, { index: 0, verified: 0, queries: t.queries, hitsUniqueUrls: t.urls.length, dropReasons: {}, review: review.map(({ reason, url }) => ({ reason, url })) })
  assert.ok(old.queries.every(q => !q.startsWith('"')))
  // an outside_window_undated candidate was READ: it is not retried
  const dated = planRetry(t.query, t.icp, { index: 0, verified: 0, queries: t.queries, hitsUniqueUrls: 1, dropReasons: {}, review: [{ reason: 'outside_window_undated', url: 'https://ca.linkedin.com/jobs/view/x', company: 'Queen Street Dental Centre' }] })
  assert.ok(dated.queries.every(q => !q.includes('Queen Street')))
})

// Independent review of this branch (fresh reviewer, 6/10 CHANGES): each point below fails without its fix.
test('#381 (review) event queries come only from a clause that names something that happened: no state, no negation, no doubled word', () => {
  assert.deepEqual(eventQueries('Dentists that are not hiring'), [], 'a negation would search for the thing the request excludes')
  assert.deepEqual(eventQueries('Companies that use Shopify'), []); assert.deepEqual(eventQueries('Restaurants that have vegan menus'), [])
  assert.deepEqual(eventQueries('Find SaaS companies in Austin that announced a new CEO'), ['SaaS companies in Austin announced a new CEO', 'SaaS companies in Austin announced a new CEO news', 'SaaS companies in Austin announced a new CEO press release'])
  // the 8 matrix requests (scorecard/matrix.json, copied): 7 name an event and get queries, Sydney ("posting about ...", no "that" clause) gets none
  const MATRIX = ['Dental clinics in Toronto, Ontario that opened a new location or are hiring front-desk staff in the last 90 days', 'Roofing companies in Austin, Texas that are hiring estimators or project managers in the last 90 days', 'Ecommerce brands in the United Kingdom running on Shopify that launched a new product in the last 90 days', 'Law firms in Chicago, Illinois that opened a new office or expanded a practice group in the last 90 days', 'Restaurants in Vancouver, British Columbia that are opening a second location in the last 90 days', 'Fintech startups in Berlin, Germany that raised a funding round in the last 90 days']
  for (const r of MATRIX) assert.ok(eventQueries(r).length >= 3, r)
})

test('#381 (review) a hiring word that is the request\'s own category is not a leaked hiring ask; the board queries, the query filter and the page ranking share one rule (the job-board SOURCE keeps its own)', () => {
  assert.equal(hiringQueryForNonHiringRequest('career coaching Chicago new location opened', 'Career coaching firms in Chicago that opened a new location'), false, 'the category word')
  assert.equal(hiringQueryForNonHiringRequest('staffing firm jobs Austin', 'Staffing firms in Austin that expanded'), true, '"jobs" is not in the request')
  // the page ranking used the raw request plus the profile signals: "opening a second location" and a profile signal about hiring both read as a hiring ask
  const vancouver = job('Restaurants'), chicago = job('Law')
  assert.equal(requestAsksHiring(vancouver.query, { signals: vancouver.icp.signals }), false, vancouver.query)
  assert.equal(requestAsksHiring(chicago.query, { signals: ['Hiring a first sales rep', ...chicago.icp.signals] }), false, 'profile signals do not make an English request a hiring request')
  assert.equal(requestAsksHiring(job('Roofing').query, {}), true)
  assert.equal(requestAsksHiring('Kanzleien in Berlin', { signals: ['stellt ein: hiring associates'], language: 'de' }), true, 'another language: the profile signals decide, as for the board queries')
})

test('#381 (review) a page whose path is dated before last year is an archive page, not an event page', () => {
  const now = new Date('2026-11-14T00:00:00Z')
  assert.equal(pageKindRank('https://acme.com/news/2019/old-office', '', true, now), 0.6)
  assert.equal(pageKindRank('https://acme.com/news/2026/new-office', '', true, now), 0)
  assert.equal(pageKindRank('https://acme.com/news/2025/12/new-office', '', true, now), 0, 'last year is still inside a 365-day window')
  assert.equal(pageKindRank('https://acme.com/news/new-office-20190', '', true, now), 0, 'a number that is not a year')
})

// (review) the pipeline itself, through the acceptance harness. REAL: the Berlin request, its profile and the queries staging sent (job of the 2026-11-13 matrix),
// one of them about hiring although the request asks for funding rounds. SYNTHETIC: the search results (none), so the scan stops after its searches.
import { runFixture, type Fixture } from './helpers/acceptance-harness.ts'
test('#381 (review) runner: the leaked hiring query is not sent, request-built event queries take the freed and the never-asked slots, open queries carry the exclusions', async () => {
  const berlin = job('Fintech'), model = berlin.queries.filter(q => !/site:/.test(q)).map(q => q.replace(/\s+Berlin, Germany$/, ''))
  assert.ok(model.some(q => /hiring CTO/.test(q)), JSON.stringify(model))
  const f: Fixture = { request: berlin.query, modelIcp: { ...berlin.icp, summary: berlin.query, who: ['Founder'], industries: ['Fintech'], sizes: [], exclude: [], language: 'en', window_days: 90 }, modelQueries: model, hits: [], tfPages: {}, own: {}, extraction: [] }
  const x = await runFixture(f)
  const sent = x.calls.searches
  assert.ok(sent.length >= 2, JSON.stringify(sent))
  assert.ok(!sent.some(q => /hiring|jobs/i.test(q)), `no hiring query for a funding request: ${JSON.stringify(sent)}`)
  // REAL shape: the model answered 2 queries (1 kept, 1 about hiring). The scan's budget is 8 searches and the model is asked for at most 6, so the request's own
  // event queries fill 1 freed slot + the 2 slots the model is never asked for: 4 searches, inside the budget of 8. (Where the budget is 3, as on staging and for a
  // first play, the model is asked for all 3 and only a dropped query is replaced.)
  assert.deepEqual(sent.map(q => q.replace(/ -site:\S+/g, '')), [
    'fintech startup Berlin raised funding million seed Series announcement Berlin, Germany',
    'Fintech startups in Berlin, Germany raised a funding round announcement',
    'Fintech startups in Berlin, Germany raised a funding round news',
    'Fintech startups in Berlin, Germany raised a funding round press release',
  ], 'the model query first, the request-built queries behind it')
  for (const q of sent) assert.match(q, /-site:facebook\.com -site:instagram\.com -site:linkedin\.com -site:youtube\.com -site:tiktok\.com$/, q)
})

// REAL: a chicago-law scan of this branch at 3 searches / 4 page reads (2026-11-14, ~/work/verify/yield/disc/disc-574976bb-3x4-chicago-law-run1.err on the builder PC).
// Its three queries all asked about "opened a new office" (the request's second event, "expanded a practice group", was never asked), and two of its four page reads
// went to one press release on two sites. Queries and addresses below are copied from that log; the titles are the headline the addresses carry (titles were not logged).
test('#381 (real scan) a free query slot goes to the event nobody asked about yet; an event the queries already cover goes last', () => {
  const request = 'Law firms in Chicago, Illinois that opened a new office or expanded a practice group in the last 90 days'
  const sent = ['Chicago law firm opened new office press release', 'law firm new office Chicago managing partner']
  assert.equal(eventQueries(request)[0], 'Law firms in Chicago, Illinois opened a new office announcement', 'with nothing asked yet: the request\'s own order')
  assert.equal(eventQueries(request, sent)[0], 'Law firms in Chicago, Illinois expanded a practice group announcement', 'what the real scan should have sent third')
  assert.equal(eventQueries(request, [...sent, 'Chicago law firm expanded practice group'])[0], 'Law firms in Chicago, Illinois opened a new office announcement', 'both covered: the request\'s order again')
})

test('#381 (real scan) one page read per story: the syndicated copy of a press release is read after the other stories, never instead of them', () => {
  const read = [
    'https://ogletree.com/media-center/press-releases/2026-10-26/ogletree-deakins-expands-chicago-office-with-three-attorneys-including-shareholder-christina-wernick',
    'https://prnewswire.com/news-releases/zayed-law-significantly-expands-chicago-office-302899256.html',
    'https://easternprogress.com/zayed-law-significantly-expands-chicago-office/article_98792e10-fcbb-544e-8326-dff51883e6bd.html',
    'https://karnsandkarns.com/press/karns-karns-personal-injury-and-accident-attorneys-opens-new-office-location-in-lincoln-park-chicago',
  ]
  const next = 'https://crokefairchild.com/2026/10/croke-fairchild-duarte-beres-and-point-of-difference-strategies-announce-move-to-new-offices-at-222-n-lasalle-street'   // a real result of the same scans, not read
  const hits = [...read, next].map(url => ({ url, title: '' }))
  const base = fetchRankFor(new Map(hits.map(h => [h.url, { date: null, title: '' }])), 90, false, new Date('2026-11-14T00:00:00Z'), false)
  assert.deepEqual(pickFetchUrls(hits.map(h => h.url), 4, base), read, 'before: what the real scan read (both Zayed Law copies)')
  const picked = pickFetchUrls(hits.map(h => h.url), 4, oneReadPerStory(hits, base))
  assert.deepEqual([...picked].sort(), [read[0], read[1], read[3], next].sort(), 'four different stories')
  // nothing is excluded: with a free slot the copy is still read
  assert.equal(pickFetchUrls(hits.map(h => h.url), 5, oneReadPerStory(hits, base)).length, 5)
  // the same headline on two addresses that share no slug (title match), and two different stories of one site
  const t = [{ url: 'https://a.example/x1', title: 'Acme Law opens a second Chicago office | A News' }, { url: 'https://b.example/y2', title: 'Acme Law opens a second Chicago office - B Wire' }, { url: 'https://a.example/x3', title: 'Beta Law expands its tax practice group | A News' }]
  const r = oneReadPerStory(t, () => 0)
  assert.deepEqual(t.map(h => r(h.url)), [0, 0.9, 0])
})

// Second independent review (opus, 6/10 CHANGES): each point fails without its fix.
test('#381 (review 2) a page two searches returned is one page, not a copy of itself; two pages of one site that share a section are not one story', () => {
  const A = 'https://acme-law.com/news/acme-law-opens-new-chicago-office-downtown', B = 'https://beta.com/news/beta-law-chicago', C = 'https://gamma.com/about'
  const hits = [A, B, A, C].map(url => ({ url, title: '' }))
  const base = fetchRankFor(new Map(hits.map(h => [h.url, { date: null, title: '' }])), 90, false, new Date('2026-11-14T00:00:00Z'), false)
  const r = oneReadPerStory(hits, base)
  assert.equal(r(A), base(A), 'returned twice: still ranked as itself')
  assert.equal(pickFetchUrls(hits.map(h => h.url), 1, r)[0], A)
  // one site, one section in the address (5+ words), two different stories
  const S1 = 'https://firm.example/category/firm-news-and-events-updates/opens-chicago', S2 = 'https://firm.example/category/firm-news-and-events-updates/hires-partner'
  const r2 = oneReadPerStory([{ url: S1 }, { url: S2 }], () => 0)
  assert.deepEqual([r2(S1), r2(S2)], [0, 0])
})

test('#381 (review 2) a request that asks for hiring in words the hiring list does not know keeps its hiring queries and its job pages', () => {
  const request = 'Dental clinics in Toronto looking for a receptionist', icp = { signals: ['hiring receptionists'] }
  assert.deepEqual(eventQueries(request), [], 'no event clause: nothing to search for instead')
  assert.equal(pagesAskHiring(request, icp), true, 'the profile signals decide the page ranking, as before')
  assert.equal(pagesAskHiring('Law firms in Chicago, Illinois that opened a new office', { signals: ['hiring a first sales rep'] }), false, 'a request with its own event: the request decides')
  assert.equal(pagesAskHiring('Roofing companies in Austin, Texas that are hiring estimators', {}), true)
})

test('#381 (review 2) "new" is not an event: a place called New York or a state ("use new software") builds no query; a slug number is not an archive year', () => {
  const qs = eventQueries('Law firms in Chicago that opened offices in Boston or New York')
  assert.ok(qs.length >= 1 && qs.every(q => !/Chicago New York (?:announcement|news|press release)$/.test(q)), JSON.stringify(qs))
  assert.deepEqual(eventQueries('Companies in Austin that use new accounting software'), [])
  const now = new Date('2026-11-14T00:00:00Z')
  for (const u of ['https://a.example/news/acme-opens-office-at-2000-main-street', 'https://a.example/news/1999-founded-firm-opens-office', 'https://a.example/p/1987-1234/acme-opens-office']) assert.equal(pageKindRank(u, '', true, now), 0, u)
  assert.equal(pageKindRank('https://a.example/news/2019/old-office', '', true, now), 0.6)
})

// (review 2) the page order through the pipeline. REAL: the Chicago request and profile and three addresses of the 2026-11-14 scan (one press release on two sites, a
// third firm's story), plus a real unrelated Greenhouse posting from the 2026-11-13 Chicago results. SYNTHETIC: titles and snippets; no page text (nothing is read back).
test('#381 (review 2) runner: with 3 page reads the scan reads three different stories; the copy on another site waits', async () => {
  const chicago = job('Law')
  const ZAYED = 'https://prnewswire.com/news-releases/zayed-law-significantly-expands-chicago-office-302899256.html', COPY = 'https://easternprogress.com/zayed-law-significantly-expands-chicago-office/article_98792e10-fcbb-544e-8326-dff51883e6bd.html'
  const KARNS = 'https://karnsandkarns.com/press/karns-karns-personal-injury-and-accident-attorneys-opens-new-office-location-in-lincoln-park-chicago', CROKE = 'https://crokefairchild.com/2026/10/croke-fairchild-duarte-beres-and-point-of-difference-strategies-announce-move-to-new-offices-at-222-n-lasalle-street'
  const JOBP = chicago.urls.map(u => u.url).find(u => /greenhouse\.io/.test(u))!
  assert.ok(JOBP, 'the real Chicago results held a Greenhouse posting')
  // the profile's signals without any hiring signal (SYNTHETIC selection): with one, an older rule (jobPagesBehindEvents) already puts job pages behind, and this
  // test would not see the new one
  const NO_HIRING_SIGNALS = ['Opened a new office in the last 90 days', 'Expanded a practice group in the last 90 days']
  const hit = (url: string, i: number) => ({ url, title: `Result ${i}`, snippet: `Synthetic snippet ${i} about a Chicago law firm.`, date: null as unknown as string })
  const f: Fixture = { request: chicago.query, modelIcp: { ...chicago.icp, signals: NO_HIRING_SIGNALS, summary: chicago.query, who: ['Managing Partner'], industries: ['Law firms'], sizes: [], exclude: [], language: 'en', window_days: 90 }, modelQueries: ['Chicago law firm opened new office press release'], hits: [], hitsFor: n => n === 0 ? [JOBP, ZAYED, COPY, ZAYED, KARNS, CROKE].map(hit) : [], tfPages: {}, own: {}, extraction: [] }
  const x = await withEnvVar('TINYFISH_FETCHES_PER_SCAN', '3', () => runFixture(f))
  const read = x.calls.tfFetchBatches.flat()
  assert.deepEqual([...read].sort(), [ZAYED, KARNS, CROKE].sort(), `three stories, not the copy: ${JSON.stringify(read)}`)
})
async function withEnvVar<T>(k: string, v: string, fn: () => Promise<T>): Promise<T> { const old = process.env[k]; process.env[k] = v; try { return await fn() } finally { if (old === undefined) delete process.env[k]; else process.env[k] = old } }

// (review 2) the page-ranking call site. For 5 of the 7 real requests an older rule (jobPagesBehindEvents) already moves job pages behind event pages, so the new
// rule shows only where that one does not apply. REAL: the Sydney request and its profile (agencies "posting about outbound": no hiring ask, no event clause, the older
// rule is off), and three addresses of the 2026-11-13 Berlin results (a Greenhouse posting, two news pages). SYNTHETIC: titles and snippets.
test('#381 (review 2) runner: a request that asks for no hiring reads the news pages before a job posting, also where the older compound-request rule is off', async () => {
  const sydney = job('Marketing'), all = job('Fintech').urls.map(u => u.url)
  assert.equal(pagesAskHiring(sydney.query, sydney.icp), false)
  const JOBP = all.find(u => /greenhouse\.io/.test(u))!, NEWS = all.filter(u => !/greenhouse\.io|ashbyhq|lever\.co/.test(u) && !isLoginWalled(u) && pageKindRank(u, '', false) === 0).slice(0, 2)
  assert.ok(JOBP && NEWS.length === 2, JSON.stringify({ JOBP, NEWS }))
  const hit = (url: string, i: number) => ({ url, title: `Result ${i}`, snippet: `Synthetic snippet ${i} about a marketing agency in Sydney.`, date: null as unknown as string })
  const f: Fixture = { request: sydney.query, modelIcp: { ...sydney.icp, summary: sydney.query, who: ['Founder'], industries: ['Marketing agencies'], sizes: [], exclude: [], language: 'en', window_days: 90 }, modelQueries: ['Sydney marketing agency outbound cold email'], hits: [], hitsFor: n => n === 0 ? [JOBP, ...NEWS].map(hit) : [], tfPages: {}, own: {}, extraction: [] }
  const x = await withEnvVar('TINYFISH_FETCHES_PER_SCAN', '2', () => runFixture(f))
  assert.deepEqual([...x.calls.tfFetchBatches.flat()].sort(), [...NEWS].sort(), 'the two news pages, not the job posting')
})
