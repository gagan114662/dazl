// Scan 8 trace, isolated (stubbed search / boards, no network): (1) which 16 of ~79 results get a fetch slot for the compound request, and (2) what the extraction model is shown for ATS evidence.
import test from 'node:test'
import assert from 'node:assert/strict'
import { daysAgo } from './helpers/acceptance-harness.ts'
import { fetchRankFor } from '../lib/scan/runner.ts'
import { pickFetchUrls } from '../lib/search/tinyfish.ts'
import { collectEvidenceReport, buildSourcePrompt } from '../lib/sources/index.ts'
import type { SafeGet } from '../lib/sources/types.ts'

const REQUEST = 'Find London UK B2B SaaS startups with 10-50 employees that announced seed funding within the past 90 days and are hiring sales staff. Exclude agencies and recruiters. Include founder contacts and dated evidence.'
const ICP = { summary: 's', who: ['Founder'], industries: ['SaaS'], sizes: ['10-50'], where: ['London, UK'], signals: ['announced seed funding', 'hiring sales staff'], exclude: [], country: 'GB', language: 'en', window_days: 90 }
const mk = (url: string, title: string, snippet: string, date: string | null) => ({ url, title, snippet, date })
const funding = Array.from({ length: 6 }, (_, i) => mk(`https://news${i}.example/co${i}-raises-seed`, `Co${i} raises seed round`, `Co${i}, a London B2B SaaS startup, raised a 3m GBP seed round`, daysAgo(10 + i)))
const company = Array.from({ length: 6 }, (_, i) => mk(`https://co${i}.io/`, `Co${i} - sales tooling`, `Co${i} builds sales tooling in London`, null))
const ats = Array.from({ length: 6 }, (_, i) => mk(`https://boards.greenhouse.io/co${i}/jobs/${100 + i}`, `Account Executive - London`, `Co${i} is hiring an Account Executive in London`, daysAgo(5 + i)))
// 60 results from distinct hosts that mention neither a raise nor hiring: listicles, directories, generic "top startups" pages
const noise = Array.from({ length: 60 }, (_, i) => mk(`https://noise${i}.example/top-startups-${i}`, `Top startups to watch ${i}`, `A roundup of startups and trends ${i}`, daysAgo(20 + (i % 30))))


const sel16 = (hits: ReturnType<typeof mk>[]) => {
  const byUrl = new Map(hits.map(h => [h.url, h])); const rank = fetchRankFor(byUrl, 90, true)
  return pickFetchUrls(hits.map(h => h.url), 16, rank)
}
const kind = (u: string) => u.includes('raises-seed') ? 'funding' : u.includes('greenhouse') ? 'ats' : /\/\/co\d\.io/.test(u) ? 'company' : 'noise'
const tally = (urls: string[]) => urls.reduce((t, u) => ({ ...t, [kind(u)]: (t[kind(u)] ?? 0) + 1 }), {} as Record<string, number>)

test('FETCH SLOTS (compound request, 16 slots of ~78 results): ranking is date class then job-page, then SEARCH ORDER by host — no relevance signal', () => {
  const mixed = [...noise.slice(0, 30), ...funding, ...company, ...ats, ...noise.slice(30)]   // 78 results; search puts irrelevant roundups first
  const a = tally(sel16(mixed)); console.log(`# slots, noise ranked first by the engine: ${JSON.stringify(a)}`)
  const b = tally(sel16([...funding, ...company, ...ats, ...noise]));  console.log(`# slots, relevant results ranked first by the engine: ${JSON.stringify(b)}`)
  assert.equal(a.funding ?? 0, 0, 'dated, irrelevant roundups ahead in search order take every slot; the funding articles and company pages behind them are never fetched')
  assert.equal(b.funding, 6, 'the same pages are fetched when the engine ranks them first'); assert.equal(b.ats ?? 0, 0, 'job-board pages come after every non-job page for a compound request')
  // undated company homepages (class 1) sit behind ALL dated inside-window pages, relevant or not
  assert.equal(tally(sel16([...company, ...noise]))['company'] ?? 0, 0)
})

const STAFF = 'Find London UK B2B SaaS startups with 10-50 employees that announced seed funding within the past 90 days and are hiring sales staff. Exclude agencies and recruiters. Include founder contacts and dated evidence.'
test('ATS ROLE FILTER (scan 8 trace): for a sales ask the board posting is kept on the sales role family; request words (SaaS, employees) are not roles', async () => {
  const titles = ['Account Executive', 'Sales Development Representative', 'SDR', 'Business Development Representative', 'Founding Account Executive (Enterprise)', 'Revenue Operations Manager', 'Head of Sales', 'Senior SaaS Engineer', 'Employees Experience Lead', 'Customer Success Manager', 'Staff Engineer']
  const body = 'We are looking for someone to join our London team and help us grow quickly across the UK market. You will work with customers.'
  const ashby = { jobs: titles.map((t, i) => ({ isListed: true, title: t, jobUrl: `https://jobs.ashbyhq.com/orbit/${i}`, location: 'London, UK', publishedAt: new Date().toISOString(), descriptionPlain: body })) }
  const http: SafeGet = async url => url === 'https://api.ashbyhq.com/posting-api/job-board/orbit' ? { status: 200, body: JSON.stringify(ashby) } : { status: 404, body: '' }
  const r = await collectEvidenceReport({ adapters: ['jobboards'], feeds: [], pages: [] }, STAFF, http, 5000, ['https://jobs.ashbyhq.com/orbit'])
  const kept = r.items.map(i => i.title.replace(/ \(London, UK\)$/, ''))
  assert.deepEqual(kept.sort(), ['Account Executive', 'Business Development Representative', 'Founding Account Executive (Enterprise)', 'Head of Sales', 'Revenue Operations Manager', 'SDR', 'Sales Development Representative'].sort())
  for (const t of ['Senior SaaS Engineer', 'Employees Experience Lead', 'Customer Success Manager', 'Staff Engineer']) assert.ok(!kept.includes(t), `${t} is not a sales role`)
})
test('ATS EVIDENCE SHAPE: a posting from a board that was only DISCOVERED (a link, not a company the scan found) is shown to the extraction model with no company name in its title or quote', async () => {
  const body = 'We are looking for an Account Executive to join our London sales team and sell our product to UK fintechs. You will own the full sales cycle.'
  const ashby = { jobs: [{ isListed: true, title: 'Account Executive', jobUrl: 'https://jobs.ashbyhq.com/orbitlabs/1', location: 'London, UK', publishedAt: new Date().toISOString(), descriptionPlain: body }] }
  const http: SafeGet = async url => url === 'https://api.ashbyhq.com/posting-api/job-board/orbitlabs' ? { status: 200, body: JSON.stringify(ashby) } : { status: 404, body: '' }
  const sel = { adapters: ['jobboards'], feeds: [] as string[], pages: [] as string[] }
  const found = await collectEvidenceReport(sel, STAFF, http, 5000, ['https://jobs.ashbyhq.com/orbitlabs'])
  assert.equal(found.items.length, 1, JSON.stringify(found.runs)); assert.ok(!/orbit/i.test(`${found.items[0].title} ${found.items[0].quote}`), 'no company name beside the posting: the model has only the URL slug to name the company from')
  const guessed = await collectEvidenceReport(sel, STAFF, http, 5000, [], undefined, [{ name: 'Orbitlabs' }])
  assert.equal(guessed.items.length, 0, 'a guessed board whose posting does not name the company is dropped (the identity rule)')
})

test('SCAN 8 URL LIST (75 URLs, Instinct\'s paste; list order taken as search order, dates NOT in the paste so every URL is treated as undated): what 16 fetch slots would have read', async () => {
  const { readFileSync } = await import('node:fs')
  const urls = readFileSync(new URL('./fixtures/scan8-urls.txt', import.meta.url), 'utf8').split('\n').filter(Boolean)
  assert.equal(urls.length, 75)
  const rank = fetchRankFor(new Map(urls.map(u => [u, { date: null }])), 90, true); const sel = pickFetchUrls(urls, 16, rank)
  const ats = (u: string) => /greenhouse\.io|ashbyhq\.com|jobs\.lever\.co/.test(u)
  const funding = (u: string) => /sesamers|law\.com\/legaltechnews|siliconrepublic|eu-startups/.test(u)
  console.log(`# scan8 list: ${urls.filter(ats).length} ATS urls, ${urls.filter(funding).length} funding-article urls (positions ${urls.map((u, i) => funding(u) ? i : -1).filter(i => i >= 0)}); of 16 slots: ATS ${sel.filter(ats).length}, funding ${sel.filter(funding).length}, rest aggregator / roundup / job-listing pages ${sel.filter(u => !ats(u) && !funding(u)).length}`)
  assert.equal(sel.filter(ats).length, 0, 'ATS job pages are behind every non-job page for a compound request (the ATS adapter reads those boards separately)')
  assert.ok(urls.filter(funding).length === 4 && sel.filter(funding).length < urls.filter(funding).length, 'with search order alone the funding articles at the end of the list lose slots to roundups and listings')
})
