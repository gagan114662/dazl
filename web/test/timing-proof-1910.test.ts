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

const htmlResponse = (body: string) => async () => new Response(`<h1>${company}</h1>${body}`)

test('#1910 recruiting wording and a job-board source require a posting date', async () => {
  for (const [signal, evidence_url] of [
    ['Recruiting a registered dental hygienist', `https://${site}/announcements/new-role`],
    ['Looking for a Dental Receptionist', 'https://www.jobbank.gc.ca/jobsearch/jobposting/123'],
  ]) {
    const candidate = { ...lead, signal, evidence_url, evidence_quote: signal }
    const seen = [{ url: evidence_url, title: company, text: null, page_age: '5 days ago' }]
    const undated = await checkLead(candidate, seen, htmlResponse(`<p>${signal}</p>`), undefined, now)
    assert.equal(undated.date, null, signal)
    const dated = await checkLead(candidate, seen, htmlResponse(`<p>${signal}</p><p>Date posted: ${day}</p>`), undefined, now)
    assert.equal(dated.date, day, signal)
  }
})

test('#1910 the hiring date ceiling includes UTC day 365 and excludes day 366', async () => {
  const today = new Date('2026-11-26T18:00:00Z')
  for (const [date, expected] of [['2025-11-26', '2025-11-26'], ['2025-11-25', null], ['2026-11-27', null]] as const) {
    const checked = await checkLead({ ...lead, signal_date: date }, [],
      htmlResponse(`<p>${opening}</p><p>Posted ${date}</p>`), undefined, today)
    assert.equal(checked.date, expected, date)
    const structured = await checkLead(lead, [], htmlResponse(
      `<p>${opening}</p><script type="application/ld+json">{"@type":"JobPosting","datePosted":"${date}"}</script>`,
    ), undefined, today)
    assert.equal(structured.date, expected, `structured posting: ${date}`)
  }
})

test('#1910 a relative posting lower bound cannot make a hiring lead Ready', async () => {
  assert.equal(await readiness(null, '<p>Posted 5+ days ago</p>'), 'research')
})

test('#1910 an exact relative posting age can make a hiring lead Ready', async () => {
  assert.equal(await readiness(null, '<p>Posted 5 days ago</p>'), 'ready_email')
})

test('#1910 dates in a URL or a relative publication or update label are not posting dates', async () => {
  for (const annotation of ['', 'Published 5 days ago', 'Updated 5 days ago']) {
    const checked = await checkLead({ ...lead, evidence_url: `${url}/${day}` }, [],
      htmlResponse(`<p>${opening}</p><p>${annotation}</p>`), undefined, now)
    assert.equal(checked.date, null, annotation || 'URL date')
  }
})

test('#1910 hourly posting ages use the UTC day of the posting', async () => {
  const readAt = new Date('2026-11-26T01:00:00Z')
  for (const [label, expected] of [
    ['Posted 2 hours ago', '2026-11-25'],
    ['Posted 30 minutes ago', null],
    ['Posted 1 hour ago', '2026-11-26'],
    ['Posted 26 hours ago', '2026-11-24'],
  ] as const) {
    const checked = await checkLead(lead, [], htmlResponse(`<p>${opening}</p><p>${label}</p>`), undefined, readAt)
    assert.equal(checked.date, expected, label)
  }
})

test('#1910 a failed source read cannot retain an index date', async () => {
  const title = `${company} — ${opening}`
  const checked = await checkLead(lead, [{ url, title, text: null, page_age: '5 days ago' }],
    async () => { throw new TypeError('fetch failed') }, undefined, now)
  assert.equal(checked.proof, 'listed')
  assert.equal(checked.date, null)
  assert.equal(checked.date_source, null)
})

test('#1910 timing proof rejects a page date when the source is unconfirmed', async () => {
  const { discoveryHiringDateProven } = await import('../lib/scan/timing-proof.ts')
  const candidate = { ...lead, date: day, date_source: 'page' as const }
  assert.equal(discoveryHiringDateProven({ ...candidate, proof: 'confirmed' }, 365, now), true)
  assert.equal(discoveryHiringDateProven({ ...candidate, proof: 'listed' }, 365, now), false)
})

test('#1910 a relative posting age with a dash can make a hiring lead Ready', async () => {
  for (const separator of ['—', '–', '-']) {
    const label = `Posted ${separator} 5 days ago`
    assert.equal(await readiness(null, `<p>${label}</p>`), 'ready_email', label)
  }
})

test('#1910 a relative update age with a dash keeps a hiring lead in Research', async () => {
  for (const separator of ['—', '–', '-']) {
    const label = `Last updated ${separator} 5 days ago`
    assert.equal(await readiness(null, `<p>${label}</p>`), 'research', label)
  }
})
