import assert from 'node:assert/strict'
import test from 'node:test'
import { parseLeads } from '../lib/discover/agent.ts'
import { checkLead, isShown } from '../lib/discover/check.ts'

const candidate = (company: string, evidence_url: string, signal: string, evidence_quote: string, alternate?: object) =>
  parseLeads(JSON.stringify({ leads: [{ company, evidence_url, signal, evidence_quote, alternate_evidence: alternate }] }), 1).leads[0]

for (const [company, board, status] of [
  ['Zilker Media', 'https://www.indeed.com/viewjob?jk=12206660f9bfcd0c', 401],
  ['DIGI Search', 'https://www.ziprecruiter.com/jobs/example', 403],
] as const) {
  test(`#1910 Austin replay: ${status} falls back only to literal evidence read by Claude`, async () => {
    // The company and board status come from the prod row replay. The alternate page is a synthetic control.
    const url = 'https://employer.example/careers'
    const quote = 'Hiring a Digital Marketing Intern'
    const lead = candidate(company, board, quote, quote, { url, quote, date: '2026-11-20' })
    const now = new Date('2026-11-26')
    const fetchBoard = async (input: RequestInfo | URL) => {
      assert.equal(String(input), board)
      return new Response('', { status })
    }
    const read = { url, text: `${company}\nHIRING   a Digital Marketing Intern — posted 20 Nov 2026.`, title: null, page_age: null }
    const result = await checkLead(lead, [read], fetchBoard, undefined, now)
    assert.equal(isShown(result), true)
    assert.equal(result.evidence_url, url)
    assert.equal(result.evidence_quote, quote)
    assert.equal(result.date, '2026-11-20')
    const unread = await checkLead(lead, [{ ...read, text: null }], fetchBoard, undefined, now)
    assert.equal(isShown(unread), false)
    const wrong = await checkLead(lead, [{ ...read, text: `Other Employer\n${quote}` }], fetchBoard, undefined, now)
    assert.equal(isShown(wrong), false)
  })
}

test('#1910 Austin replay: punctuation and case vary, but a paraphrase or invented tail stays held', async () => {
  const company = 'Resplendent Agency'
  const url = 'https://resplendent.agency/were-hiring-social-media-intern-fall/'
  const headline = "We're Hiring: Social Media Intern (Fall)"
  const fetchPage = async () => new Response(`<h1>${company}</h1><p>${headline}</p>`)
  for (const [quote, shown] of [
    ['WE’RE HIRING — Social   Media Intern, Fall', true],
    ['Resplendent Agency is hiring a Social Media Intern to join our PR team in Austin, Texas.', false],
    [`${headline}, with a guaranteed job offer`, false],
  ] as const) {
    const result = await checkLead(candidate(company, url, 'Hiring a Social Media Intern', quote), [], fetchPage)
    assert.equal(result.quote_on_page, shown, quote)
    assert.equal(isShown(result), shown, quote)
  }
})
