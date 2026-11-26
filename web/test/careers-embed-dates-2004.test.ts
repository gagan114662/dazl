// #2004, careers pages (the slice after the job-board stack): many companies serve their own careers page and embed the board inside it.
// The page then names its own posting record in its markup - a Greenhouse embed iframe, a Lever/Ashby/Workable posting link - and that
// record is the page's own data, so its day counts. Only when the page names exactly one posting: two different postings on one page
// settle nothing, and the day still passes the same future and age guards as every other board record.
import test from 'node:test'
import assert from 'node:assert/strict'
import { careersAtsDate, embeddedAtsPosting } from '../lib/discover/ats-dates.ts'
import { checkLead } from '../lib/discover/check.ts'
import type { DiscoveredLead } from '../lib/discover/agent.ts'

const NOW = new Date('2026-11-26T12:00:00Z')
const CAREERS = 'https://careers.example.test/jobs/sales-development-representative'
const html = (body: string) => `<html><body>${body}</body></html>`
const ghEmbed = (token: string, id: string) => `<iframe src="https://boards.greenhouse.io/embed/job_app?for=${token}&token=${id}"></iframe>`
const leverFrame = (org: string, id: string) => `<iframe src="https://jobs.lever.co/${org}/${id}/apply"></iframe>`
const leverLink = (org: string, id: string) => `<a href="https://jobs.lever.co/${org}/${id}">Apply</a>`
const jsonFetch = (routes: Record<string, unknown>) => (async (u: string | URL) => {
  const url = String(u)
  const hit = Object.keys(routes).find(k => url.startsWith(k))
  return hit ? new Response(JSON.stringify(routes[hit]), { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('nope', { status: 404 })
}) as unknown as typeof fetch

test('#2004 careers page: a Greenhouse embed names the posting record, and its day is the day', async () => {
  const page = html(`<h1>Sales Development Representative</h1>${ghEmbed('acme', '4012345')}`)
  const rec = embeddedAtsPosting(page, CAREERS)
  assert.equal(rec?.apiUrl, 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345')
  assert.equal(rec?.platform, 'greenhouse')
  const day = await careersAtsDate(page, CAREERS, jsonFetch({ 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345': { first_published: '2026-11-10T00:00:00-05:00' } }), NOW)
  assert.deepEqual(day, { date: '2026-11-10', sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345', platform: 'greenhouse' })
})

test('#2004 careers page: two different postings embedded settle nothing', async () => {
  const page = html(`${ghEmbed('acme', '4012345')}${leverFrame('acme', '3f1c2b9e-1111-4a2b-8c3d-000000000001')}`)
  assert.equal(embeddedAtsPosting(page, CAREERS), null)
  assert.equal(await careersAtsDate(page, CAREERS, jsonFetch({}), NOW), null)
})

test('#2004 careers page: the same posting named twice is still one posting', async () => {
  const page = html(`${ghEmbed('acme', '4012345')}<iframe src="https://boards.greenhouse.io/acme/jobs/4012345"></iframe>`)
  assert.equal(embeddedAtsPosting(page, CAREERS)?.apiUrl, 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345')
})

test('#2004 careers page: a page that only LINKS a posting, without embedding it, gives nothing', async () => {
  const page = html(`<p>We wrote about the market.</p>${leverLink('acme', '3f1c2b9e-1111-4a2b-8c3d-000000000001')}`)
  assert.equal(embeddedAtsPosting(page, CAREERS), null, 'a link is a reference, not this page’s posting')
  assert.equal(await careersAtsDate(page, CAREERS, jsonFetch({}), NOW), null)
})

test('#2004 careers page: a page that names no board record gives nothing, and no fetch is made', async () => {
  let called = 0
  const counting = (async () => { called++; return new Response('{}') }) as unknown as typeof fetch
  assert.equal(embeddedAtsPosting(html('<h1>Careers</h1><p>Email us.</p>'), CAREERS), null)
  assert.equal(await careersAtsDate(html('<h1>Careers</h1>'), CAREERS, counting, NOW), null)
  assert.equal(called, 0, 'nothing was asked of a board the page never named')
})

test('#2004 careers page: a record whose day is in the future or past the window gives nothing', async () => {
  const page = html(ghEmbed('acme', '4012345'))
  const url = 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345'
  assert.equal(await careersAtsDate(page, CAREERS, jsonFetch({ [url]: { first_published: '2027-01-05T00:00:00Z' } }), NOW), null, 'future')
  assert.equal(await careersAtsDate(page, CAREERS, jsonFetch({ [url]: { first_published: '2020-01-05T00:00:00Z' } }), NOW), null, 'stale')
  assert.equal(await careersAtsDate(page, CAREERS, jsonFetch({ [url]: {} }), NOW), null, 'no date field')
})

test('#2004 careers page end to end: the embedded Lever record dates the lead through the real check', async () => {
  const id = '3f1c2b9e-1111-4a2b-8c3d-000000000001'
  const text = 'Northwind careers. Sales Development Representative. We are hiring Sales Development Representatives now.'
  const page = html(`<p>${text}</p>${leverFrame('northwind', id)}`)
  const fetchImpl = (async (u: string | URL) => {
    const url = String(u)
    if (url.startsWith('https://api.lever.co/')) return new Response(JSON.stringify({ createdAt: Date.parse('2026-11-06T00:00:00Z') }), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.startsWith('https://careers.example.test/')) return new Response(page, { status: 200, headers: { 'content-type': 'text/html' } })
    return new Response('nope', { status: 404 })
  }) as unknown as typeof fetch
  const lead: DiscoveredLead = {
    company: 'Northwind', domain: null, signal: 'Northwind is hiring Sales Development Representatives', signal_date: null,
    evidence_url: CAREERS, evidence_quote: 'We are hiring Sales Development Representatives now', person: null, title: null,
    person_source_url: null, linkedin_url: null, email: null, email_source_url: null, confidence: 'high', why: 'careers page',
  }
  const checked = await checkLead(lead, [], fetchImpl, 5_000, NOW)
  assert.equal(checked.proof, 'confirmed')
  assert.equal(checked.date, '2026-11-06')
  assert.equal(checked.date_source, 'page')
  assert.equal(checked.date_on_page, false, 'the day came from the board record the page names, not from the page text')
})
