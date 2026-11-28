// #2004, company careers pages (the slice after the job-board stack): a careers posting page on the company's own domain usually carries
// its posting as a typed JobPosting node, but it also carries the "related jobs" rail, which is a JobPosting node or two for OTHER
// postings. Two misses follow from that, and both lose a real date:
//   1. the rail's node can come first, so the page's own node is never looked at;
//   2. the page then holds more than one posting, so the single-posting rule refuses the node that names this page.
// Neither may invent a date: a node that does not name this page and whose title the page does not print is still refused.
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkLead, datesThisPosting, structuredDay } from '../lib/discover/check.ts'
import type { DiscoveredLead } from '../lib/discover/agent.ts'

const NOW = new Date('2026-11-26T12:00:00Z')
const PAGE = 'https://careers.example.test/jobs/sales-development-representative'
const page = (blocks: string[], text: string) => blocks.map(b => `<script type="application/ld+json">${b}</script>`).join('\n') + `\n<p>${text}</p>`
const fetchOf = (body: string) => (async () => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
const lead = (signal: string, quote: string): DiscoveredLead => ({
  company: 'Northwind', domain: null, signal, signal_date: null, evidence_url: PAGE, evidence_quote: quote, person: null, title: null,
  person_source_url: null, linkedin_url: null, email: null, email_source_url: null, confidence: 'high', why: 'careers page',
})
const posting = (url: string, day: string, title: string) => JSON.stringify({
  '@context': 'https://schema.org', '@graph': [{ '@type': 'JobPosting', title, url, datePosted: day, hiringOrganization: { '@type': 'Organization', name: 'Northwind' } }],
})
const rail = (id: string, day: string) => JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', title: `Other job ${id}`, url: `https://careers.example.test/jobs/${id}`, datePosted: day })

test('#2004 careers page: the posting node that names this page dates it, even with a related-jobs rail on the same page', () => {
  const html = page([posting(PAGE, '2026-11-12', 'Sales Development Representative'), rail('account-executive', '2026-11-20'), rail('support-lead', '2026-11-21')], 'Sales Development Representative. We are hiring.')
  const s = structuredDay(html, NOW, true, new URL(PAGE))
  assert.deepEqual([s?.day, s?.field], ['2026-11-12', 'JobPosting.datePosted'], 'the page’s own posting, not the rail')
  assert.equal(datesThisPosting(s!, 'Sales Development Representative. We are hiring.', new URL(PAGE)), true, 'naming this page is enough, whatever else the page carries')
})

test('#2004 careers page: a rail node that comes first does not shadow the posting that names this page', () => {
  const html = page([rail('account-executive', '2026-11-20'), posting(PAGE, '2026-11-12', 'Sales Development Representative')], 'Sales Development Representative. We are hiring.')
  assert.equal(structuredDay(html, NOW, true, new URL(PAGE))?.day, '2026-11-12')
})

test('#2004 careers page: no fabrication - a node naming another page, with a title this page does not print, gives no day', () => {
  const html = page([rail('account-executive', '2026-11-20'), rail('support-lead', '2026-11-21')], 'Open roles at Northwind.')
  const s = structuredDay(html, NOW, true, new URL(PAGE))
  assert.equal(datesThisPosting(s!, 'Open roles at Northwind.', new URL(PAGE)), false)
  const lone = structuredDay(page([rail('account-executive', '2026-11-20')], 'Open roles at Northwind.'), NOW, true, new URL(PAGE))!
  assert.equal(datesThisPosting(lone, 'Open roles at Northwind.', new URL(PAGE)), false, 'a lone rail node with no printed title is not this posting either')
})

test('#2004 careers page: a page with no typed posting stays undated rather than borrowing a neighbour or the rail', async () => {
  const html = page([rail('account-executive', '2026-11-20')], 'Sales Development Representative. We are hiring.')
  const checked = await checkLead(lead('Northwind is hiring Sales Development Representatives', 'We are hiring'), [], fetchOf(html), 5_000, NOW)
  assert.equal(checked.date_source === 'page' && checked.date === '2026-11-20', false, 'the rail’s day is never this lead’s day')
})

test('#2004 careers page end to end: the rail does not stop the page’s own typed day from dating the lead', async () => {
  const text = 'Northwind careers. Sales Development Representative. We are hiring Sales Development Representatives now.'
  const html = page([rail('account-executive', '2026-11-20'), posting(PAGE, '2026-11-12', 'Sales Development Representative')], text)
  const checked = await checkLead(lead('Northwind is hiring Sales Development Representatives', 'We are hiring Sales Development Representatives now'), [], fetchOf(html), 5_000, NOW)
  assert.equal(checked.proof, 'confirmed')
  assert.equal(checked.date, '2026-11-12')
  assert.equal(checked.date_on_page, true)
})

test('#2004 careers page: a rail node on the same path but a different posting (query) does not date the lead', () => {
  const url = 'https://careers.example.test/jobs?posting=sdr'
  const own = JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Sales Development Representative', url, datePosted: '2026-11-12' })
  const other = JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Account Executive', url: 'https://careers.example.test/jobs?posting=ae', datePosted: '2026-11-20' })
  const body = page([other, own], 'Sales Development Representative. Account Executive. We are hiring.')
  const s = structuredDay(body, NOW, true, new URL(url))
  assert.equal(s?.day, '2026-11-12', "the page's own posting, not the same-path rail node")
  assert.equal(datesThisPosting(s!, 'Sales Development Representative. Account Executive. We are hiring.', new URL(url)), true)
})
