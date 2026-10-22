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
