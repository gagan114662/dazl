import test from 'node:test'
import assert from 'node:assert/strict'
import { makeJudge, verifyLeads, type LeadDraft } from '../lib/scan/runner.ts'
import type { Page } from '../lib/scan/fetch-page.ts'

const company = 'Northside Builders'
const excerpt = 'We opened a new warehouse after construction finished.'
const c: LeadDraft = { name: '', company, contact: null, signal: 'Northside Builders opened a new warehouse',
  source_url: 'https://northsidebuilders.example/news', score: 70, excerpt, event_date: null }
const page: Page = { text: excerpt, title: "Northside Builders’ announcements", retrievedAt: 1 }

async function run(p: Page, reply: (prompt: string) => string, candidate = c, headingContext = true) {
  const requests: string[] = []
  const judge = makeJudge({ research: async () => ({ text: '', citedUrls: [] }), complete: async (_key, prompt) => {
    requests.push(prompt)
    return reply(prompt)
  } }, 'offline-fixture', undefined, undefined, headingContext)
  const result = await verifyLeads([candidate], async () => p, new Date('2026-10-20T12:00:00Z'), judge)
  return { result, requests }
}

test('judge receives same-page heading only when it bound the company, plus the already verified excerpt', async () => {
  const { result, requests } = await run(page, prompt =>
    prompt.includes('Same-page heading: "Northside Builders’ announcements"') && prompt.includes(JSON.stringify(excerpt.toLowerCase())) ? 'supports' : 'unclear')
  assert.equal(result.leads[0]?.confidence, 60)
  assert.equal(requests.length, 1)
  assert.match(requests[0], /untrusted data/)
  assert.match(requests[0], /does not establish that the claimed event happened/)
  const ordinary = await run(page, () => 'unclear', c, false)
  assert.equal(ordinary.result.dropped.claim_unclear, 1)
  assert.doesNotMatch(ordinary.requests[0], /Same-page heading|Matched body quote/)
  const inlineQuote = company + ': ' + excerpt
  const inline = await run({ ...page, text: inlineQuote }, () => 'supports', { ...c, excerpt: inlineQuote })
  assert.equal(inline.result.leads.length, 1)
  assert.doesNotMatch(inline.requests[0], /Same-page heading/)
  const otherEvent = await run({ ...page, text: 'Rival Holdings said: ' + excerpt }, () => 'contradicts')
  assert.equal(otherEvent.result.dropped.contradicted, 1)
  assert.equal(otherEvent.requests.length, 1)
})

test('structured ATS employer may bind, but the posting title and slug never become judge employer evidence', async () => {
  const board = { company, slug: 'northsidebuilders', title: 'Private job title sentinel' }
  const employer = await run({ ...page, title: board.title, board }, prompt =>
    prompt.includes('Structured ATS employer: "Northside Builders"') ? 'supports' : 'unclear')
  assert.equal(employer.result.leads.length, 1)
  assert.doesNotMatch(employer.requests[0], /Private job title sentinel|Same-page heading/)
  const slugOnly = await run({ ...page, board: { ...board, company: null } }, () => 'unclear')
  assert.equal(slugOnly.result.dropped.claim_unclear, 1)
  assert.doesNotMatch(slugOnly.requests[0], /Structured ATS employer|Same-page heading/)
  const jobTitleOnly = await run({ ...page, board: { ...board, company: null, slug: 'different' } }, () => 'supports')
  assert.equal(jobTitleOnly.result.dropped.entity_mismatch, 1)
  assert.equal(jobTitleOnly.requests.length, 0)
})
