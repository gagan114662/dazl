// Which pages get the scarce fetch slots. The failed London scoreboard scan (scan 2/20): every one of the 16 fetched pages was a job page,
// many from large companies outside the target, so extraction had nothing and verification never ran. All hits below are INVENTED.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture, type Hit } from './helpers/acceptance-harness.ts'
process.env.TINYFISH_PER_MINUTE = '1000' // the stub answers instantly; the per-minute pacing is not under test
process.env.TINYFISH_FETCHES_PER_SCAN = '6' // the search stub returns at most 10 results per query, so the fetch budget is scaled down to keep the shortage real
import { isJobPage, needsEventBeyondHiring } from '../lib/search/page-class.ts'
import { extractionNote, emptyExtractionReason, type ExtractionNote } from '../lib/scan/extraction-note.ts'

const LONDON = 'Find London UK B2B SaaS startups with 10-50 employees that announced seed funding within the past 90 days and are hiring sales staff. Exclude agencies and recruiters. Include founder contacts and dated evidence.'
const ICP = { summary: 'London seed-funded B2B SaaS hiring sales', who: ['Founder'], industries: ['SaaS'], sizes: ['10-50'], where: ['London, UK'], signals: ['announced seed funding', 'hiring sales staff'], exclude: ['agencies', 'recruiters'], country: 'GB', language: 'en', window_days: 90 }
const HIRING_ONLY = 'Find London UK companies hiring sales account executives in the past 90 days.'
const ICP_H = { ...ICP, signals: ['hiring sales account executives'] }
const jobHits = (n: number): Hit[] => Array.from({ length: n }, (_, i) => ({ url: `https://boards.greenhouse.io/bigco${i}/jobs/${100 + i}`, title: `Sales Executive - BigCo ${i}`, snippet: `BigCo ${i} is hiring a Sales Executive in London`, date: daysAgo(3 + (i % 5)) }))
const newsHits = (n: number): Hit[] => Array.from({ length: n }, (_, i) => ({ url: `https://news${i}.example/seed-round-${i}`, title: `Startup ${i} raises seed round`, snippet: `Startup ${i} has raised a seed round`, date: null }))
const fx = (request: string, icp: object, hits: Hit[]): Fixture => ({ request, modelIcp: icp, modelQueries: ['London SaaS startup seed round'], hits, tfPages: Object.fromEntries(hits.map(h => [h.url, { title: h.title, text: `${h.snippet}. ${'Filler text about the page. '.repeat(30)}` }])), own: {}, extraction: [] })
const fetched = (r: Awaited<ReturnType<typeof runFixture>>) => r.calls.tfFetchBatches.flat()

test('isJobPage / needsEventBeyondHiring', () => {
  for (const u of ['https://boards.greenhouse.io/acme/jobs/1', 'https://jobs.lever.co/acme/x', 'https://jobs.ashbyhq.com/acme', 'https://uk.indeed.com/viewjob?jk=1', 'https://acme.example/careers/sales', 'https://acme.example/jobs/12', 'https://www.linkedin.com/jobs/view/1']) assert.equal(isJobPage(u), true, u)
  for (const u of ['https://news.example/acme-raises-seed', 'https://acme.example/about', 'https://sifted.eu/articles/acme', 'https://www.linkedin.com/company/acme', 'not a url']) assert.equal(isJobPage(u), false, u)
  assert.equal(needsEventBeyondHiring(ICP.signals, LONDON), true)
  assert.equal(needsEventBeyondHiring(ICP_H.signals, HIRING_ONLY), false)
  assert.equal(needsEventBeyondHiring(['opened a new location', 'posted a front desk receptionist job'], 'dental practices that opened a new location or posted a job'), true)
  assert.equal(needsEventBeyondHiring(['posted a front desk receptionist job'], 'dental practices in New York City that posted a front desk receptionist job'), false)
})

test('seed-funding + hiring request: undated news pages are fetched before dated big-company job pages (before the fix every slot went to a job page)', async () => {
  const r = await runFixture(fx(LONDON, ICP, [...jobHits(7), ...newsHits(3)]))
  const urls = fetched(r)
  assert.equal(urls.length, 6)
  assert.equal(urls.filter(u => !isJobPage(u)).length, 3, `all three non-job pages get a slot: ${urls.join(' ')}`)
  assert.equal(urls.filter(isJobPage).length, 3, 'the job pages still take the remaining slots (nothing is excluded)')
  assert.ok(urls.slice(0, 3).every(u => !isJobPage(u)), 'non-job pages come first')
})

test('control: a hiring-only request still fetches job pages first (ordering by window class only)', async () => {
  const r = await runFixture(fx(HIRING_ONLY, ICP_H, [...newsHits(3), ...jobHits(7)]))
  const urls = fetched(r)
  assert.equal(urls.length, 6)
  assert.ok(urls.slice(0, 6).every(isJobPage), `dated job pages first for a hiring-only request: ${urls.join(' ')}`)
})

test('nothing is excluded and no gate changes: with room for all pages every page is still fetched', async () => {
  const r = await runFixture(fx(LONDON, ICP, [...jobHits(4), ...newsHits(2)]))
  assert.equal(fetched(r).length, 6)
})

// ---- End to end: the London seed-funding + sales-hiring target must come out when job pages from large companies crowd the results ----
const TARGET_SENTENCE = 'Brightloop, a London B2B SaaS startup with 24 employees, raised a 3m GBP seed round this month and is hiring two account executives to build its sales team'
const NEWS = 'https://sifted.example/brightloop-raises-seed'
const stubProviders = (promptsSeen: string[]) => {
  const reply = (p: string, maxTokens?: number) => {
    promptsSeen.push(p)
    if (maxTokens === 300) return JSON.stringify(['London B2B SaaS startup raises seed round', 'London SaaS startup hiring account executive sales'])
    // The stub model only finds the target when the funding article's TEXT is in what it was given (a search snippet alone does not carry it).
    return p.includes(TARGET_SENTENCE) ? JSON.stringify([{ name: '', company: 'Brightloop', contact: null, signal: 'raised a seed round and is hiring account executives', source_url: NEWS, score: 80, excerpt: TARGET_SENTENCE, event_date: daysAgo(12) }]) : '[]'
  }
  const p = { research: async () => ({ text: '[]', citedUrls: [] }), complete: async (_k: string, pr: string, _f?: typeof fetch, mt?: number) => reply(pr, mt), completeDetailed: async (_k: string, pr: string, _f?: typeof fetch, mt?: number) => ({ text: reply(pr, mt), model: 'stub', usage: { input_tokens: 10, output_tokens: 1 } }), configuredModel: () => 'stub' }
  return { anthropic: p, openai: p }
}
function londonFixture(promptsSeen: string[]): Fixture {
  const bigJobs = jobHits(6)                                   // large companies outside the target, dated inside the window (they used to take every slot)
  const hits: Hit[] = [
    ...bigJobs,
    { url: NEWS, title: 'Brightloop raises seed round', snippet: 'London SaaS startup Brightloop has closed a seed round', date: null },
    { url: 'https://sifted.example/other-news', title: 'Paris fintech raises Series B', snippet: 'A Paris fintech closed a Series B', date: null },
    { url: 'https://boards.greenhouse.io/brightloop/jobs/7', title: 'Account Executive - Brightloop', snippet: 'Brightloop is hiring an Account Executive in London', date: daysAgo(4) },
    { url: 'https://news.example/ldn-ai-startups', title: 'London startups to watch', snippet: 'A roundup', date: null },
  ]
  const tf = Object.fromEntries(hits.map(h => [h.url, { title: h.title, text: `${h.url === NEWS ? `Published ${daysAgo(12)}. ${TARGET_SENTENCE}.` : h.snippet + '.'} ${'More page text about the company and its people. '.repeat(20)}` }]))
  return { request: LONDON, modelIcp: ICP, modelQueries: [], hits, tfPages: tf, own: { [NEWS]: { title: 'Brightloop raises seed round', text: tf[NEWS].text } }, extraction: [], deps: { providers: stubProviders(promptsSeen) } }
}

test('London seed + sales-hiring target is produced and verified even when large companies’ job pages crowd the results', async () => {
  const seen: string[] = []
  const r = await runFixture(londonFixture(seen))
  const urls = fetched(r)
  assert.ok(urls.includes(NEWS), `the funding article is fetched: ${urls.join(' ')}`)
  const lead = r.leads.find(l => l.company === 'Brightloop')
  assert.ok(lead, `the target is a candidate: ${JSON.stringify(r.leads)} ${JSON.stringify(r.job)}`)
  assert.equal(lead!.review_reason, null, 'verified: quote, company, date and place gates unchanged'); assert.ok(lead!.confidence !== null)
  assert.equal(r.leads.filter(l => /BigCo/.test(l.company)).length, 0, 'no large-company job posting becomes a lead')
})

test('when extraction returns nothing the run report keeps factual counts and the reason states only what is known (no claim that no company matches)', async () => {
  const f = londonFixture([])
  f.deps = { providers: stubProviders([]) }
  f.hits = f.hits.filter(h => h.url !== NEWS && !h.url.includes('other-news') && !h.url.includes('ldn-ai'))   // only job pages left: the failed live scan's shape
  f.tfPages = Object.fromEntries(Object.entries(f.tfPages).filter(([u]) => f.hits.some(h => h.url === u)))
  const r = await runFixture(f)
  assert.equal(r.leads.length, 0)
  const ex = (r.report as { extraction?: ExtractionNote }).extraction
  assert.ok(ex, JSON.stringify(r.report?.extracted_candidates))
  assert.deepEqual([ex!.results, ex!.requested, ex!.fetched, ex!.fetch_failed, ex!.fetch_error, ex!.offered, ex!.snippet_only, ex!.job_pages_fetched, ex!.reply, ex!.returned, ex!.reason], [7, 6, 6, 0, false, 7, 1, 6, 'usable', 0, 'returned_zero'])
  const text = emptyExtractionReason(ex)!
  assert.match(text, /The search returned 7 results; dazl asked to read 6 pages and read 6\./); assert.match(text, /given 7 items \(6 page texts, 1 search snippet\) and returned 0 candidates\./); assert.match(text, /Every page read was a job posting\./)
  assert.match(text, /does not show that no matching companies exist/); assert.doesNotMatch(text, /none described|contained no|no matching company\b(?! exist)/); assert.doesNotMatch(text, /https?:/)
})

test('partial fetch: pages that could not be read are counted as failed, not as read, and the wording says so', async () => {
  const f = londonFixture([])
  f.deps = { providers: stubProviders([]) }
  f.hits = f.hits.filter(h => h.url !== NEWS && !h.url.includes('other-news') && !h.url.includes('ldn-ai'))
  const keep = f.hits.slice(0, 3).map(h => h.url)                                   // TinyFish returns text for only 3 of the pages dazl asked for
  f.tfPages = Object.fromEntries(Object.entries(f.tfPages).filter(([u]) => keep.includes(u)))
  const r = await runFixture(f)
  const ex = (r.report as { extraction?: ExtractionNote }).extraction!
  assert.deepEqual([ex.requested, ex.fetched, ex.fetch_failed, ex.fetch_error, ex.job_pages_fetched, ex.snippet_only], [6, 3, 3, false, 3, ex.offered - 3])
  const text = emptyExtractionReason(ex)!
  assert.match(text, /asked to read 6 pages and read 3 \(3 pages could not be read\)/); assert.match(text, /3 page texts/); assert.doesNotMatch(text, /and read 6/)
})

test('fetch call failure and unusable reply are stated as such; nothing is claimed when extraction returned candidates', () => {
  const base = { results: 10, requested: 6, fetchedUrls: [] as string[], fetchError: true, items: [{ url: 'https://news.example/a' }], parsed: [] as unknown[] | null }
  const failed = emptyExtractionReason(extractionNote(base))!
  assert.match(failed, /page-reading call failed, so none were read/); assert.match(failed, /given 1 item \(0 page texts, 1 search snippet\) and returned 0 candidates/)
  const unusable = extractionNote({ ...base, fetchError: false, fetchedUrls: ['https://news.example/a'], parsed: null })
  assert.equal(unusable.reason, 'reply_unusable'); assert.equal(unusable.returned, null); assert.match(emptyExtractionReason(unusable)!, /answer could not be read, so nothing was extracted\. This says nothing about whether matching companies exist/)
  assert.equal(extractionNote({ ...base, parsed: [{}] }).reason, null); assert.equal(emptyExtractionReason(extractionNote({ ...base, parsed: [{}] })), null); assert.equal(emptyExtractionReason(null), null)
  const mixed = emptyExtractionReason(extractionNote({ ...base, fetchError: false, fetchedUrls: ['https://boards.greenhouse.io/a/jobs/1', 'https://news.example/b'], items: [{ url: 'https://boards.greenhouse.io/a/jobs/1' }, { url: 'https://news.example/b' }] }))!
  assert.match(mixed, /1 of the 2 pages read were job postings/)
})
