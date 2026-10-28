// Public Greenhouse / Lever / Ashby boards probed by slug guess for the companies a scan itself found. Stub http only: no live endpoint, no key.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectEvidenceReport } from '../lib/sources/index.ts'
import { guessSlugs } from '../lib/sources/jobboards.ts'
import type { SafeGet } from '../lib/sources/types.ts'

const ms = (n: number) => Date.now() - n * 86_400_000
const QUERY = 'London UK startups hiring sales account executives'
const SEL = { adapters: ['jobboards'], feeds: [] as string[], pages: [] as string[] }
const lever = (host: string, text: string, quote: string, loc = 'London, UK', age = 9) => [{ text, hostedUrl: `https://jobs.lever.co/${host}/1`, createdAt: ms(age), categories: { location: loc, allLocations: [loc] }, descriptionPlain: `${quote} ${'x'.repeat(40)}` }]
function stub(boards: Record<string, unknown>) {
  const seen: string[] = []
  const http: SafeGet = async url => {
    const h = new URL(url).hostname
    if (h === 'hn.algolia.com') return { status: 404, body: '' }
    seen.push(url)
    const b = boards[url]
    return b === undefined ? { status: 404, body: '' } : { status: 200, body: JSON.stringify(b) }
  }
  return { http, seen }
}
const run = (companies: { name: string; domain?: string | null }[], http: SafeGet) => collectEvidenceReport(SEL, QUERY, http, 5000, [], undefined, companies)

test('guessSlugs: domain label first, then the bare and hyphenated name; never a too-short or malformed token', () => {
  assert.deepEqual(guessSlugs({ name: 'Brightloop Ltd', domain: 'brightloop.io' }), [{ token: 'brightloop', byDomain: true }, { token: 'brightloopltd', byDomain: false }, { token: 'brightloop-ltd', byDomain: false }])
  assert.deepEqual(guessSlugs({ name: 'Acme' }), [{ token: 'acme', byDomain: false }])
  assert.deepEqual(guessSlugs({ name: 'AB' }), [])
})

test('a company the scan found: its public Lever board is probed and a dated London sales posting that names it becomes evidence led by the company name', async () => {
  const { http, seen } = stub({ 'https://api.lever.co/v0/postings/brightloop?mode=json': lever('brightloop', 'Account Executive', 'Brightloop is hiring an Account Executive in London to sell our payments product to UK fintechs.') })
  const r = await run([{ name: 'Brightloop' }], http)
  assert.equal(r.items.length, 1, JSON.stringify(r)); assert.match(r.items[0].title, /^Brightloop: Account Executive/); assert.equal(r.items[0].source, 'jobboards')
  assert.ok(seen.includes('https://api.lever.co/v0/postings/brightloop?mode=json') && seen.includes('https://api.ashbyhq.com/posting-api/job-board/brightloop') && seen.includes('https://boards-api.greenhouse.io/v1/boards/brightloop/jobs'), 'all three public boards probed')
  assert.ok(seen.every(u => /^https:\/\/(?:api\.lever\.co|api\.ashbyhq\.com|boards-api\.greenhouse\.io)\//.test(u)), 'only the documented hosts')
  assert.equal(r.runs[0].status, 'ok'); assert.equal(r.runs[0].notes, undefined, '404s on guessed boards are normal, never a partial result')
})

test('IDENTITY: a guessed slug that is another company\'s board is NOT evidence — a posting that does not name the company is dropped', async () => {
  const { http } = stub({ 'https://api.lever.co/v0/postings/acme?mode=json': lever('acme', 'Account Executive', 'Acme Robotics is hiring an Account Executive in London to sell warehouse robots.') })
  const r = await run([{ name: 'Acme Dental' }, { name: 'Acme' }].slice(1), http)
  assert.equal(r.items.length, 1, 'Acme named in the posting: kept')
  const wrong = await run([{ name: 'Acme' }], stub({ 'https://api.lever.co/v0/postings/acme?mode=json': lever('acme', 'Account Executive', 'Initech is hiring an Account Executive in London.') }).http)
  assert.equal(wrong.items.length, 0, 'the board at that slug belongs to Initech, so nothing is attributed to Acme'); assert.equal(wrong.runs[0].status, 'empty')
})

test('a domain-slug board is the company\'s by its domain; the place, role and window gates still apply to its postings', async () => {
  const p = [...lever('brightloop', 'Account Executive', 'We are hiring in London for our sales team and want a closer.'), ...lever('brightloop', 'Account Executive', 'Sales role in Austin.', 'Austin, TX').map(x => ({ ...x, hostedUrl: 'https://jobs.lever.co/brightloop/2' })), ...lever('brightloop', 'Account Executive', 'Old London sales role posted long ago.', 'London, UK', 300).map(x => ({ ...x, hostedUrl: 'https://jobs.lever.co/brightloop/3' })), ...lever('brightloop', 'Software Engineer', 'London engineering role.').map(x => ({ ...x, hostedUrl: 'https://jobs.lever.co/brightloop/4' }))]
  const r = await run([{ name: 'The Loop Co', domain: 'brightloop.io' }], stub({ 'https://api.lever.co/v0/postings/brightloop?mode=json': p }).http)
  assert.deepEqual(r.items.map(i => i.url), ['https://jobs.lever.co/brightloop/1'], 'only the London, in-window, sales posting')
  assert.match(r.items[0].title, /^The Loop Co: Account Executive/)
})

test('bounded: guessed boards share the adapter\'s one cap of 10 board lists, and nothing is requested when no company was found', async () => {
  const { http, seen } = stub({})
  await run(Array.from({ length: 10 }, (_, i) => ({ name: `Company${i}x` })), http)
  assert.ok(seen.length === 10, `probed ${seen.length}`); assert.ok(!seen.some(u => u.includes('company9x')), 'later companies are not probed once the cap is used')
  const none = stub({}); await run([], none.http); assert.equal(none.seen.length, 0)
})

test('a guessed board answering HTTP 200 with {} / no jobs array is a parse failure (partial), never a healthy empty board; a plain 404 stays silent', async () => {
  const http: SafeGet = async url => (new URL(url).hostname === 'hn.algolia.com' ? { status: 404, body: '' } : url.includes('greenhouse') ? { status: 200, body: '{}' } : { status: 404, body: '' })
  const r = await run([{ name: 'Brightloop' }], http)
  assert.equal(r.runs[0].status, 'partial'); assert.ok(r.runs[0].notes?.unparseable)
})
