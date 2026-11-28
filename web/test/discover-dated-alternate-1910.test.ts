import assert from 'node:assert/strict'
import test from 'node:test'
import type { DiscoverResult, DiscoveredLead } from '../lib/discover/agent.ts'
import { isShown } from '../lib/discover/check.ts'
import { runDiscovery } from '../lib/discover/run.ts'

const quote = 'Fern Dental is hiring a dental receptionist in Toronto'
const posted = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10)
const indexDay = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10)
const indeed = 'https://ca.indeed.com/viewjob?jk=fixture'
const zip = 'https://www.ziprecruiter.com/c/Fern-Dental/Job/Receptionist'
const talent = 'https://ca.talent.com/view?id=fixture'
const careers = 'https://ferndental.example/careers/receptionist'
const ats = 'https://job-boards.greenhouse.io/ferndental/jobs/123'
const record = 'https://boards-api.greenhouse.io/v1/boards/ferndental/jobs/123'

async function scan({ source, status, alternate = careers, page, apiDay, seen = true, onSecondPass = false, returnedAlternate = true, extraPages = [] }: {
  source: string; status: number; alternate?: string; page: string; apiDay?: string; seen?: boolean; onSecondPass?: boolean; returnedAlternate?: boolean;
  extraPages?: DiscoverResult['seen']
}) {
  const lead: DiscoveredLead = {
    company: 'Fern Dental', domain: 'ferndental.example', signal: quote, signal_date: indexDay,
    evidence_url: source, evidence_quote: quote, alternate_evidence: returnedAlternate ? { url: alternate, quote, date: indexDay } : undefined,
    person: null, title: null, person_source_url: null, linkedin_url: null, email: null, email_source_url: null,
    confidence: 'high', why: '',
  }
  const found: DiscoverResult = {
    leads: [lead],
    seen: [{ url: source, title: quote, page_age: '2 days ago', text: null },
      ...(seen ? [{ url: alternate, title: quote, page_age: '1 day ago', text: null }] : []), ...extraPages],
    usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0, searches: 3, requests: 1, usd: 0.044 },
    stop: 'end_turn', model: 'claude-opus-5-5', note: null,
  }
  const reads: string[] = []
  let passes = 0
  const run = await runDiscovery({ query: 'Dental clinics hiring in Toronto' }, { maxUsd: onSecondPass ? 1 : 0.1 }, {
    apiKey: 'fixture', judge: null, enrich: null,
    discover: async () => onSecondPass && passes++ === 0 ? { ...found, leads: [], seen: [] } : found,
    fetch: async input => {
      const url = String(input)
      reads.push(url)
      if (url === source) return new Response('Sign in to see the posting', { status })
      if (url === alternate) return new Response(`<html><body>${page}</body></html>`)
      if (url === record && apiDay) return Response.json({ first_published: apiDay })
      return new Response(null, { status: 404 })
    },
  })
  assert.equal(run.leads.length, 1)
  return { lead: run.leads[0], reads, passes: run.passes }
}

test('an unreadable Indeed posting falls back to the matching employer posting and its own date', async () => {
  const result = await scan({ source: indeed, status: 401, page: `<p>${quote}.</p><p>Posted on ${posted}.</p>` })
  assert.deepEqual([result.lead.evidence_url, result.lead.date, result.lead.date_source, result.lead.date_on_page, isShown(result.lead)],
    [careers, posted, 'page', true, true])
  assert.deepEqual(result.reads, [indeed, careers])
})

test('a forbidden ZipRecruiter listing can use the exact ATS posting record on the second pass', async () => {
  const result = await scan({ source: zip, status: 403, alternate: ats, page: `<p>${quote}.</p>`, apiDay: posted, onSecondPass: true })
  assert.equal(result.passes, 2)
  assert.deepEqual([result.lead.evidence_url, result.lead.date, result.lead.date_source, result.lead.date_on_page, isShown(result.lead)],
    [ats, posted, 'page', true, true])
  assert.deepEqual(result.reads, [zip, ats, record])
})

test('a Talent sign-in page can use a dated, matching employer posting', async () => {
  const { lead } = await scan({ source: talent, status: 200, page: `<p>${quote}.</p><p>Posted ${posted}.</p>` })
  assert.deepEqual([lead.evidence_url, lead.date, lead.date_on_page], [careers, posted, true])
})

test('an unreadable search result stays undated when the employer page has no posting date', async () => {
  const { lead } = await scan({ source: indeed, status: 401, page: `<p>${quote}.</p><p>Updated ${posted}.</p>` })
  assert.deepEqual([lead.evidence_url, lead.date, lead.date_source], [indeed, null, null])
})

test('an unrelated ATS owner or a URL absent from the search trace is never used', async () => {
  const page = `<p>${quote}.</p><p>Posted ${posted}.</p>`
  for (const options of [{ alternate: 'https://job-boards.greenhouse.io/unrelated/jobs/123' }, { seen: false }]) {
    const result = await scan({ source: zip, status: 403, page, ...options })
    assert.deepEqual([result.lead.evidence_url, result.lead.date, result.reads], [zip, null, [zip]])
  }
})

test('the run can follow a single employer posting already found by the search without an explicit alternate', async () => {
  const { lead } = await scan({ source: indeed, status: 401, page: `<p>${quote}.</p><p>Posted ${posted}.</p>`, returnedAlternate: false })
  assert.deepEqual([lead.evidence_url, lead.date, lead.date_on_page], [careers, posted, true])
})

test('multiple employer postings use a unique posting whose read text matches the cited opening', async () => {
  const opening = 'https://ferndental.example/jobs/front-desk'
  const result = await scan({ source: indeed, status: 403, returnedAlternate: false, page: 'Unrelated opening',
    extraPages: [{ url: opening, title: quote, page_age: null, text: `${quote}. Posted on ${posted}.` }] })
  assert.deepEqual([result.lead.evidence_url, result.lead.date, isShown(result.lead)], [opening, posted, true])
})

test('multiple employer postings without a matching read stay held', async () => {
  const { lead } = await scan({ source: indeed, status: 403, returnedAlternate: false, page: 'Unrelated opening',
    extraPages: [{ url: 'https://ferndental.example/jobs/bookkeeper', title: quote, page_age: null,
      text: `Fern Dental is hiring a bookkeeper in Toronto. Posted on ${posted}.` }] })
  assert.deepEqual([lead.evidence_url, lead.date, isShown(lead)], [indeed, null, false])
})

test('two eligible employer postings with the cited opening stay held even with valid dates', async () => {
  const first = 'https://ferndental.example/jobs/front-desk'
  const second = 'https://ferndental.example/jobs/receptionist'
  const text = `${quote}. Posted on ${posted}.`
  const extraPages = [first, second].map(url => ({ url, title: quote, page_age: null, text }))

  for (const candidate of extraPages) {
    const { lead } = await scan({ source: indeed, status: 403, alternate: candidate.url,
      page: `<p>${text}</p>`, seen: false, returnedAlternate: false, extraPages: [candidate] })
    assert.deepEqual([lead.evidence_url, lead.date, isShown(lead)], [candidate.url, posted, true])
  }

  const { lead, reads } = await scan({ source: indeed, status: 403, page: `<p>${text}</p>`,
    seen: false, returnedAlternate: false, extraPages })
  assert.deepEqual([lead.evidence_url, lead.date, isShown(lead), reads], [indeed, null, false, [indeed]])
})

test('a date in unrelated JobPosting markup does not date an employer careers listing', async () => {
  const alternate = 'https://ferndental.example/careers'
  const page = `<p>${quote}.</p><script type="application/ld+json">{"@type":"JobPosting","title":"Bookkeeper","datePosted":"${posted}"}</script>`
  const { lead } = await scan({ source: indeed, status: 401, alternate, page })
  assert.deepEqual([lead.evidence_url, lead.date, lead.date_source], [indeed, null, null])
})

test('an ATS page cannot promote unrelated markup when its posting record has no publication date', async () => {
  const page = `<p>${quote}.</p><script type="application/ld+json">{"@type":"JobPosting","title":"Bookkeeper","datePosted":"${posted}"}</script>`
  const { lead } = await scan({ source: zip, status: 403, alternate: ats, page })
  assert.deepEqual([lead.evidence_url, lead.date, lead.date_source], [zip, null, null])
})
