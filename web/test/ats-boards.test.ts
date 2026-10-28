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

test('a domain-slug board still needs the posting to name the company (a shared label binds nothing); the place, role and window gates still apply', async () => {
  const p = [...lever('brightloop', 'Account Executive', 'The Loop Co is hiring in London for our sales team and wants a closer.'), ...lever('brightloop', 'Account Executive', 'Sales role in Austin.', 'Austin, TX').map(x => ({ ...x, hostedUrl: 'https://jobs.lever.co/brightloop/2' })), ...lever('brightloop', 'Account Executive', 'Old London sales role posted long ago.', 'London, UK', 300).map(x => ({ ...x, hostedUrl: 'https://jobs.lever.co/brightloop/3' })), ...lever('brightloop', 'Software Engineer', 'London engineering role.').map(x => ({ ...x, hostedUrl: 'https://jobs.lever.co/brightloop/4' }))]
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

// ---- #323 review (exact head 71f670c): a failed posting read is a failure, and a shared domain label does not bind a board ----
const GH_LIST = { jobs: [{ id: 7, title: 'Account Executive', location: { name: 'London, UK' } }] }
const ghHttp = (detail: (() => { status: number; body: string } | null)): SafeGet => async url => {
  if (new URL(url).hostname === 'hn.algolia.com') return { status: 404, body: '' }
  if (url === 'https://boards-api.greenhouse.io/v1/boards/brightloop/jobs') return { status: 200, body: JSON.stringify(GH_LIST) }
  if (url === 'https://boards-api.greenhouse.io/v1/boards/brightloop/jobs/7') return detail() as { status: number; body: string }
  return { status: 404, body: '' }
}
const GH_DETAIL = { title: 'Account Executive', location: { name: 'London, UK' }, first_published: new Date(ms(9)).toISOString(), absolute_url: 'https://boards.greenhouse.io/brightloop/jobs/7', content: 'Brightloop is hiring an Account Executive in London to sell our payments product to UK fintechs.' + ' x'.repeat(30) }
const ghRun = async (detail: () => { status: number; body: string } | null) => { const r = await collectEvidenceReport(SEL, QUERY, ghHttp(detail), 5000, [], undefined, [{ name: 'Brightloop' }]); return { r, gh: r.runs.find(x => x.collector === 'ats:greenhouse') } }

test('Greenhouse list 200 with a matching London AE posting but the detail endpoint 503: a source failure (partial), never a healthy empty/0', async () => {
  const { r, gh } = await ghRun(() => ({ status: 503, body: '' }))
  assert.equal(r.runs[0].collector, 'adapter:jobboards'); assert.equal(r.runs[0].status, 'partial', JSON.stringify(r.runs)); assert.ok((r.runs[0].notes?.http_error ?? 0) >= 1)
  assert.equal(gh?.status, 'partial:1_of_2', JSON.stringify(r.runs)); assert.equal(r.items.length, 0)
})
test('the same board: detail unreachable (timeout / no answer), a malformed 200 and an oversize body are failures too; a healthy detail is ok with the posting', async () => {
  for (const [name, d] of [['no answer', () => null], ['malformed json', () => ({ status: 200, body: '{nope' })], ['not an object', () => ({ status: 200, body: '[]' })]] as const) {
    const { r, gh } = await ghRun(d); assert.equal(r.runs[0].status, 'partial', name); assert.equal(gh?.status, 'partial:1_of_2', `${name} ${JSON.stringify(r.runs)}`)
  }
  const ok = await ghRun(() => ({ status: 200, body: JSON.stringify(GH_DETAIL) })); assert.equal(ok.r.items.length, 1); assert.equal(ok.r.runs[0].status, 'ok'); assert.equal(ok.gh?.status, 'ok')
  const gone = await ghRun(() => ({ status: 404, body: '' })); assert.equal(gone.r.runs[0].status, 'empty', 'a posting that vanished between list and detail (404) is a normal empty')
})
test('IDENTITY: candidate {Acme Dental, acme.dental}: the board at /acme is only found by the shared domain label — a Lever posting that names Initech is NOT attributed to Acme Dental', async () => {
  const { http } = stub({ 'https://api.lever.co/v0/postings/acme?mode=json': lever('acme', 'Account Executive', 'Initech is hiring an Account Executive in London to sell our payments product to UK fintechs.') })
  const r = await run([{ name: 'Acme Dental', domain: 'acme.dental' }], http)
  assert.equal(r.items.length, 0, JSON.stringify(r.items)); assert.equal(r.runs[0].status, 'empty')
  const own = stub({ 'https://api.lever.co/v0/postings/acme?mode=json': lever('acme', 'Account Executive', 'Acme Dental is hiring an Account Executive in London to sell our payments product to UK fintechs.') })
  const r2 = await run([{ name: 'Acme Dental', domain: 'acme.dental' }], own.http); assert.equal(r2.items.length, 1); assert.match(r2.items[0].title, /^Acme Dental: /)
})
