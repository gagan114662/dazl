import test from 'node:test'
import assert from 'node:assert/strict'
import { counterpartySignal, hostBrand } from '../lib/scan/counterparty.ts'
import { verifyLeads } from '../lib/scan/runner.ts'

const linearLead = { name: '', company: 'Salesforce', contact: null, signal: 'Salesforce became a Linear customer earlier this year', source_url: 'https://linear.app/now/sharing-growth', score: 80, excerpt: 'Salesforce and Figma, which both became customers earlier this year', event_date: null }
const linearPage = { title: 'Sharing growth with the people building Linear', text: 'Linear grew fast. Salesforce and Figma, which both became customers earlier this year. Many leading AI companies, including OpenAI, also run product development in Linear.', retrievedAt: 1792696500 }

test('hostBrand extracts the first label and rejects junk', () => {
  assert.equal(hostBrand('https://linear.app/now/x'), 'linear')
  assert.equal(hostBrand('https://www.notion.com/blog/x'), 'notion')
  assert.equal(hostBrand('https://example'), null)
  assert.equal(hostBrand('https://localhost/x'), null)
})

test('lead named as customer on the counterparty marketing page is a subject mismatch', () => {
  assert.equal(counterpartySignal(linearLead, linearPage, ''), 'source_owner:linear')
})

test('source belonging to the lead itself is not a mismatch', () => {
  const notion = { ...linearLead, company: 'Notion', source_url: 'https://www.notion.com/blog/tender', signal: 'Notion raised a tender', excerpt: 'Investors purchased shares from Notion employees in a $270M tender' }
  assert.equal(counterpartySignal(notion, { ...linearPage, text: 'Investors purchased shares from Notion employees in a tender' }, ''), null)
})

test('independent ATS/news source without customer phrasing is untouched', () => {
  const job = { ...linearLead, company: 'Conga', source_url: 'https://job-boards.greenhouse.io/conga/jobs/5252041007', signal: 'Hiring Staff Sales Operations Manager', excerpt: 'Conga is hiring a Staff Sales Operations Manager' }
  assert.equal(counterpartySignal(job, { ...linearPage, title: 'Job Application for Staff Sales Operations Manager at Conga', text: 'Conga is hiring a Staff Sales Operations Manager' }, ''), null)
})

test('end to end: counterparty lead goes to review, never lead list, no contact', async () => {
  const result = await verifyLeads([linearLead], async () => linearPage, new Date('2026-10-22T00:00:00Z'))
  assert.equal(result.leads.length, 0)
  assert.equal(result.review[0].review_reason, 'counterparty_signal')
  assert.equal(result.review[0].contact, null)
})

// #767: a public ATS posting belongs to the board's org, not to the board host ("jobs" of jobs.ashbyhq.com). A company's own posting that links
// zapier.com/l/jobs/... next to "using AI tools" is its own vacancy, not a counterparty mention; another company's board still is one.
test('hostBrand of a public ATS posting is the board org, so a company\'s own posting is never a counterparty', () => {
  const id = '6adee270-03bf-4b1b-915b-eba5fb56d1b6'
  assert.equal(hostBrand(`https://jobs.ashbyhq.com/zapier/${id}`), 'zapier')
  assert.equal(hostBrand(`https://jobs.lever.co/brightloop/${id}`), 'brightloop')
  assert.equal(hostBrand('https://boards.greenhouse.io/brightloop/jobs/4012345'), 'brightloop')
  assert.equal(hostBrand('https://jobs.ashbyhq.com/zapier'), 'jobs', 'not a posting shape: the host rule is unchanged')
  const page = { title: 'Sales Assist Representative @ zapier', text: 'Sales Assist Representative (APAC). Job posting on the zapier Ashby job board. AI AT ZAPIER At Zapier https://zapier.com/about, we build and use automation every day. So if you’re using AI tools while applying here - that’s great! Check out How to Collaborate with AI During Zapier’s Hiring Process https://zapier.com/l/jobs/ai-at-zapier. We’re looking for a new Sales-Assist Representative to join the Sales-Assist Motion at Zapier.', retrievedAt: 0 }
  const own = { name: '', company: 'Zapier', contact: null, signal: 'hiring a Sales Assist Representative', source_url: `https://jobs.ashbyhq.com/zapier/${id}`, score: 80, excerpt: 'We’re looking for a new Sales-Assist Representative to join the Sales-Assist Motion at Zapier.', event_date: null }
  assert.equal(counterpartySignal(own as never, page as never, ''), null)
  const other = { ...own, company: 'Brightloop', source_url: `https://jobs.ashbyhq.com/zapier/${id}` }
  const named = { title: 'Sales Assist Representative @ zapier', text: 'Brightloop uses Zapier for its sales workflows, and we are hiring to support customers like it.', retrievedAt: 0 }
  assert.equal(counterpartySignal(other as never, named as never, ''), 'source_owner:zapier', 'another company named on Zapier\'s own posting is still a counterparty mention')
})
// #767 review R4: an ATS org slug is compared with the WHOLE company key, never its first word
test('an ATS org brand is matched on the whole company key: "AI Corp" on the retail board is a counterparty, "Brightloop" on brightloophq is its own', () => {
  const id = '6adee270-03bf-4b1b-915b-eba5fb56d1b6'
  const page = { title: 'Account Executive @ retail', text: 'AI Corp uses Retail for its stores, and we are hiring an Account Executive to grow accounts like it.', retrievedAt: 0 }
  const ai = { name: '', company: 'AI Corp', contact: null, signal: 'AI Corp uses Retail', source_url: `https://jobs.ashbyhq.com/retail/${id}`, score: 80, excerpt: 'AI Corp uses Retail for its stores', event_date: null }
  assert.equal(counterpartySignal(ai as never, page as never, ''), 'source_owner:retail')
  const own = { ...ai, company: 'Brightloop', source_url: `https://jobs.ashbyhq.com/brightloophq/${id}` }
  assert.equal(counterpartySignal(own as never, { ...page, title: 'x @ brightloophq', text: 'Brightloop uses Brightloophq tooling; we are hiring an Account Executive.' } as never, ''), null)
})
// round 2 R4: a prefix is not enough ("Ramp" is not "rampart"); equality or the name plus a known board-slug suffix is
test('an ATS org brand is the lead\'s own only when equal or the name plus a known suffix: "Ramp" on the rampart board is a counterparty', () => {
  const id = '6adee270-03bf-4b1b-915b-eba5fb56d1b6'
  const page = { title: 'Account Executive @ rampart', text: 'Ramp uses Rampart for security reviews, and we are hiring an Account Executive.', retrievedAt: 0 }
  const lead = (company: string, org: string) => ({ name: '', company, contact: null, signal: 'x', source_url: `https://jobs.ashbyhq.com/${org}/${id}`, score: 80, excerpt: 'Ramp uses Rampart for security reviews', event_date: null })
  assert.equal(counterpartySignal(lead('Ramp', 'rampart') as never, page as never, ''), 'source_owner:rampart')
  for (const org of ['ramp', 'ramphq', 'ramplabs', 'rampio', 'rampcareers']) assert.equal(counterpartySignal(lead('Ramp', org) as never, { ...page, text: `Ramp uses ${org} tooling.` } as never, ''), null, org)
})
