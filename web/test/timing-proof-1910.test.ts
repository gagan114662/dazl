import assert from 'node:assert/strict'
import test from 'node:test'
import { parseLeads } from '../lib/discover/agent.ts'
import { discoverState } from '../lib/discover/card.ts'
import { checkLead } from '../lib/discover/check.ts'

const site = 'example-dental.test'
const company = 'Example Dental Clinic'
const opening = 'Hiring a registered dental hygienist'
const url = `https://${site}/careers/hygienist`
const now = new Date()
const day = new Date(now.getTime() - 5 * 86_400_000).toISOString().slice(0, 10)
const lead = parseLeads(JSON.stringify({ leads: [{
  company, signal: opening, evidence_quote: opening, evidence_url: url, signal_date: day,
}] }), 1).leads[0]
assert.ok(lead)

async function readiness(postingDate: string | null, otherMarkup = '') {
  const html = `<h1>${company}</h1><p>${opening}</p>${postingDate ? `<p>Posted ${postingDate}</p>` : ''}${otherMarkup}`
  const checked = await checkLead(lead, [{ url, title: company, text: null, page_age: '5 days ago' }],
    async () => new Response(html), undefined, now)
  const row = {
    source_kind: 'discover', signal: opening, company_domain: site, name: 'Dana Rivera',
    event_date: checked.date, date_status: checked.date_on_page ? 'verified' : 'unverified',
    event_date_proof: checked.date_on_page ? 'page_bound' : null,
    fit: 4, intent: 4, review_reason: null,
    enrichments: [
      { connector: 'discover', kind: 'person', value: 'Dana Rivera, Owner', source_url: `https://${site}/team` },
      { connector: 'discover', kind: 'email', value: `dana@${site}`, source_url: `https://${site}/contact` },
    ],
  }
  assert.equal(checked.signal_seen, true, 'the hiring claim itself has independent proof')
  return discoverState(row)
}

test('#1910 a hiring signal without a posting date stays in Research even if the index dated the page', async () => {
  assert.equal(await readiness(null), 'research')
})

test('#1910 a hiring signal with a posting date inside the window can be Ready', async () => {
  assert.equal(await readiness(day), 'ready_email')
})

test('#1910 unrelated page dates cannot establish a hiring posting date', async () => {
  assert.equal(await readiness(null, `<p>Applications close ${day}</p>`), 'research')
  assert.equal(await readiness(null, `<script type="application/ld+json">{"datePublished":"${day}"}</script>`), 'research')
})

test('#1910 a structured posting date can make a hiring lead Ready', async () => {
  assert.equal(await readiness(null, `<script type="application/ld+json">{"@type":"JobPosting","datePosted":"${day}"}</script>`), 'ready_email')
})
