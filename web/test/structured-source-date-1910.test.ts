import assert from 'node:assert/strict'
import test from 'node:test'
import { parseLeads } from '../lib/discover/agent.ts'
import { checkLead } from '../lib/discover/check.ts'
import { discoverState } from '../lib/discover/card.ts'

const company = 'Fixture Workshop'
const hiring = 'Hiring a production coordinator'
const expansion = 'Opening a second workshop'
const now = new Date()
const date = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10)
const otherDay = new Date(now.getTime() - 172_800_000).toISOString().slice(0, 10)

const jsonLd = (value: object) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`
const posting = (day: string) => ({ '@type': 'JobPosting', datePosted: day })
const proofText = (signal: string) => `<h1>${company}</h1><p>${signal}</p>`

async function check(markup: string, signal = hiring, responseUrl?: string) {
  const url = signal === hiring ? 'https://fixture.example/careers/opening' : 'https://fixture.example/news/second-workshop'
  const lead = parseLeads(JSON.stringify({ leads: [{
    company, signal, evidence_quote: signal, evidence_url: url,
  }] }), 1).leads[0]
  assert.ok(lead)
  const checked = await checkLead(lead, [], async request => {
    assert.equal(String(request), url)
    const response = new Response(proofText(signal) + markup)
    if (responseUrl) Object.defineProperty(response, 'url', { value: responseUrl })
    return response
  }, undefined, now)
  assert.equal(checked.signal_seen, true)
  return checked
}

test('JobPosting JSON-LD dates the hiring signal and makes a named buyer Ready', async () => {
  const checked = await check(jsonLd({ '@graph': [posting(`${date}T23:45:00-07:00`)] }))
  assert.equal(checked.date, date)
  assert.equal(checked.date_source, 'page')
  const enrichments = [
    { kind: 'person', connector: 'discover', value: 'Ari Stone, Owner', source_url: 'https://fixture.example/team' },
    { kind: 'email', connector: 'discover', value: 'ari.stone@fixture.example', source_url: 'https://fixture.example/team', label: 'published on a public page' },
  ]
  assert.equal(discoverState({
    source_kind: 'discover', company_domain: 'fixture.example', event_date: checked.date, enrichments,
  }), 'ready_email')
})

test('reversed article metadata attributes date a non-hiring signal', async () => {
  const checked = await check(`<meta content="${date}T12:00:00Z" property="article:published_time">`, expansion)
  assert.equal(checked.date, date)
  assert.equal(checked.date_source, 'page')
})

test('explicit posting and publication time elements supply the date', async () => {
  assert.equal((await check(`<p>Posted: <time datetime="${date}">yesterday</time></p>`)).date, date)
  assert.equal((await check(`<time datetime="${date}" itemprop="datePublished">yesterday</time>`, expansion)).date, date)
})

test('unrelated or ambiguous dates cannot date the hiring signal', async () => {
  for (const markup of [
    jsonLd({ '@type': 'Article', datePosted: date }),
    jsonLd({ datePosted: date }),
    jsonLd({ ...posting(date), url: '/careers/a-different-job' }),
    `<script>const unrelated = {"datePosted":"${date}"}</script>`,
    jsonLd([posting(date), posting(otherDay)]),
    jsonLd(posting('2026-02-30')),
    `<meta property="article:published_time" content="${date}">`,
    `<p>Updated: <time datetime="${date}">yesterday</time></p>`,
    `<p>Apply by <time datetime="${date}">tomorrow</time></p>`,
  ]) {
    assert.equal((await check(markup)).date, null, markup)
  }
})

test('metadata from a different final URL cannot date the cited signal', async () => {
  assert.equal((await check(jsonLd(posting(date)), hiring, 'https://fixture.example/careers')).date, null)
})
