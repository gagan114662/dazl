// RED-FIRST (run aa19373443a2df2799185f33, prod 383ada0a): the company-first funding pass returned 5 candidates, all cited to
// multi-company roundups (a fashion-law AI investment tracker; a substack "funding rounds report weekly"), all undated -> held.
// Gagan's bar: a funding signal is dated and sourced from the company's OWN newsroom/press/blog, or a dated article about THAT company.
// No host lists (that is hardcoding): the rules are structural.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fundingSourceVerdicts } from '../lib/company-first/funding-source.ts'

const roundup = 'https://parsers.substack.com/p/funding-rounds-report-weekly-of-november-74f'
const tracker = 'https://www.thefashionlaw.com/generative-artificial-intelligence-investment-and-ma-tracker/'

test('one URL cited for 2+ different companies is a roundup: every one of them is rejected as a funding source', () => {
  const v = fundingSourceVerdicts([
    { company: 'Charta Health', website: 'chartahealth.com', source_url: roundup, event_date: null },
    { company: 'Applied Carbon', website: 'appliedcarbon.com', source_url: roundup, event_date: null },
    { company: 'Duet', website: 'duet.com', source_url: roundup + '?utm=x', event_date: '2026-11-10' },
  ])
  assert.deepEqual(v.map(x => x.verdict), ['reject', 'reject', 'reject'])
  assert.ok(v.every(x => x.reason === 'multi_company_roundup'))
})

test('the same roundup cited for a single company in this pass is still rejected when undated', () => {
  const v = fundingSourceVerdicts([{ company: 'Autobound', website: 'autobound.ai', source_url: tracker, event_date: null }])
  assert.equal(v[0].verdict, 'reject')
  assert.equal(v[0].reason, 'undated_third_party')
})

test("the company's own dated announcement page is accepted (host equals or is a subdomain of its own website)", () => {
  const v = fundingSourceVerdicts([
    { company: 'Acme', website: 'acme.io', source_url: 'https://acme.io/blog/series-a', event_date: '2026-11-05' },
    { company: 'Beta', website: 'https://www.beta.com/', source_url: 'https://news.beta.com/press/seed', event_date: '2026-10-30' },
  ])
  assert.deepEqual(v.map(x => [x.verdict, x.reason]), [['accept', 'own_site'], ['accept', 'own_site']])
})

test('a lookalike host is not the company own site', () => {
  const v = fundingSourceVerdicts([{ company: 'Acme', website: 'acme.io', source_url: 'https://acme.io.evil.com/raise', event_date: '2026-11-05' }])
  assert.equal(v[0].reason === 'own_site', false)
})

test('a dated third-party article cited for exactly one company passes on to the normal reader (not trusted, just not rejected here)', () => {
  const v = fundingSourceVerdicts([{ company: 'Gamma', website: 'gamma.app', source_url: 'https://techcrunch.com/2026/11/12/gamma-raises', event_date: '2026-11-12' }])
  assert.deepEqual([v[0].verdict, v[0].reason], ['read', 'single_company_article'])
})

test('a job posting is never a funding source', () => {
  for (const u of ['https://jobs.ashbyhq.com/acme/1', 'https://job-boards.greenhouse.io/acme/jobs/2', 'https://jobs.lever.co/acme/3', 'https://acme.io/careers/sdr']) {
    const v = fundingSourceVerdicts([{ company: 'Acme', website: 'acme.io', source_url: u, event_date: '2026-11-05' }])
    assert.equal(v[0].verdict, 'reject', u)
    assert.equal(v[0].reason, 'job_posting', u)
  }
})

test('an own-site page with no date is rejected (the reader may not invent one)', () => {
  const v = fundingSourceVerdicts([{ company: 'Acme', website: 'acme.io', source_url: 'https://acme.io/news/raise', event_date: null }])
  assert.deepEqual([v[0].verdict, v[0].reason], ['reject', 'undated_own_site'])
})
