import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fundingSourceVerdicts, roundupPage } from '../lib/company-first/funding-source.ts'

// Qodo on #1530 (PM gate, 2026-11-22)
test('(a) an undated own announcement or single-company article is not discarded at intake: the reader may still date it from the page', () => {
  const v = fundingSourceVerdicts([
    { company: 'Acme', website: 'acme.io', source_url: 'https://acme.io/news/acme-raises-series-a', event_date: null },
    { company: 'Gamma', website: 'gamma.app', source_url: 'https://techcrunch.com/2026/11/12/gamma-raises', event_date: null },
  ])
  assert.deepEqual(v.map(x => x.verdict), ['read', 'read'])
})
test('(b) the page itself is a roundup: a list/weekly/report address or title, or rounds of 2+ different companies, even when cited once and dated', () => {
  assert.equal(roundupPage('https://parsers.substack.com/p/funding-rounds-report-weekly-of-november-74f', 'Funding Rounds Report', ''), true)
  assert.equal(roundupPage('https://news.example/p/x', 'This week in AI funding', ''), true)
  assert.equal(roundupPage('https://news.example/p/x', 'Startup news', 'Charta Health raised a $12M seed round. Applied Carbon raised a $20M Series A. Duet closed its seed.'), true)
  assert.equal(roundupPage('https://news.example/2026/11/12/gamma-raises', 'Gamma raises $12M', 'Gamma raised a $12M Series A led by Accel. Gamma said it will hire. Accel partner joins the board.'), false)
  const v = fundingSourceVerdicts([{ company: 'Duet', website: 'duet.com', source_url: 'https://news.example/p/x', event_date: '2026-11-10',
    page: { title: 'Startup news', text: 'Duet raised a $5M seed round. Applied Carbon raised a $20M Series A.' } }])
  assert.deepEqual([v[0].verdict, v[0].reason], ['reject', 'multi_company_roundup'])
})
test('(c) a careers or jobs page is never a funding source, with or without a website hint', () => {
  for (const u of ['https://acme.io/careers', 'https://acme.io/careers/sdr', 'https://acme.io/jobs/123', 'https://acme.io/en/careers/sales', 'https://careers.acme.io/sdr', 'https://acme.io/job/sdr', 'https://acme.io/open-positions'])
    for (const website of ['acme.io', null]) assert.equal(fundingSourceVerdicts([{ company: 'Acme', website, source_url: u, event_date: '2026-11-05' }])[0].reason, 'job_posting', `${u} ${website}`)
})
