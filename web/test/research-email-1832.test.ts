// #1832: a Research-only lead shows the email the company published. The published-email line already on those rows
// (app/app/leads/field-provenance.tsx PublishedEmailProvenance) hid a found address in three ways: a restricted
// inbox (press@...) read as "unavailable", a discovery-lane address whose source page was not the company's own
// site was dropped, and a row whose hold is not a searchable one never rendered the line at all. The line is
// display only: the address, the page it was published on, and no action - research only stays research only.
// Rendered with the same tsx-loader as test/lead-field-provenance-1401.test.ts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

register('./helpers/tsx-loader.mjs', import.meta.url)
const loadFields = () => import('../app/app/leads/field-provenance.tsx')
const client = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')

const enrichment = (connector: string, kind: string, value: string, source_url: string, label: string | null = null) =>
  ({ connector, kind, value, source_url, label })

test('#1832: a restricted inbox is the company\'s published address, shown display only - not "unavailable"', async () => {
  const { PublishedEmailProvenance } = await loadFields()
  const lead = { company_domain: 'acme.example', source_url: 'https://news.example/story', contact: 'press@acme.example', enrichments: [] }
  const html = renderToStaticMarkup(createElement(PublishedEmailProvenance, { lead }))
  assert.match(html, /press@acme\.example/)
  assert.match(html, /display only/)
  assert.match(html, /press inbox, not a sales contact/)
  assert.doesNotMatch(html, /unavailable/)
  // the source link is the page the address was published on, and nothing here is a control
  assert.match(html, /href="https:\/\/news\.example\/story"/)
  assert.doesNotMatch(html, /<button|onClick/)
})

test('#1832: the named person\'s own address shows wherever the run found it; one printed only by another site is display only', async () => {
  const { PublishedEmailProvenance } = await loadFields()
  const lead = { source_kind: 'discover', company_domain: 'acme.example', source_url: 'https://news.example/story',
    contact: null, enrichments: [
      enrichment('discover', 'person', 'Dana Ruiz, Founder', 'https://jobs.example/dana'),
      enrichment('discover', 'email', 'dana.ruiz@provider.example', 'https://jobs.example/dana'),
    ] }
  const html = renderToStaticMarkup(createElement(PublishedEmailProvenance, { lead }))
  assert.match(html, /dana\.ruiz@provider\.example/)
  assert.match(html, /href="https:\/\/jobs\.example\/dana"/)
  assert.match(html, /display only/)
  assert.match(html, /not a contact/)
  assert.doesNotMatch(html, /unavailable/)
  assert.doesNotMatch(html, /<button|onClick/)
})

test('#1832: nothing is invented - an enricher record dazl does not publish still shows no address', async () => {
  const { PublishedEmailProvenance } = await loadFields()
  const lead = { source_kind: 'discover', company_domain: 'acme.example', source_url: 'https://news.example/story',
    contact: null, enrichments: [enrichment('hunter', 'email', 'bought@acme.example', 'https://broker.example/record')] }
  const html = renderToStaticMarkup(createElement(PublishedEmailProvenance, { lead }))
  assert.match(html, /Published work email unavailable/)
  assert.doesNotMatch(html, /bought@acme\.example|broker\.example/)
})

test('#1832: a crawled address keeps its own page as the source', async () => {
  const { PublishedEmailProvenance } = await loadFields()
  const lead = { company_domain: 'acme.example', source_url: 'https://news.example/story', contact: null, enrichments: [
    enrichment('sitecrawl', 'domain', 'acme.example|evidence_own_domain', 'https://acme.example/contact', 'domain-basis-v1:evidence_own_domain'),
    enrichment('sitecrawl', 'email', 'sales@acme.example', 'https://acme.example/contact'),
  ] }
  const html = renderToStaticMarkup(createElement(PublishedEmailProvenance, { lead }))
  assert.match(html, /sales@acme\.example/)
  assert.match(html, /href="https:\/\/acme\.example\/contact"/)
  assert.doesNotMatch(html, /unavailable/)
})

test('#1832: the research rows render the line even under a hold that is not a searchable one; the website line keeps its gate', () => {
  // the searchable-hold line from #1401 stays as it is
  assert.match(client, /!l\.quarantined_at && peopleSearchable\(l\.review_reason\) && <div className="text-xs"><WebsiteProvenance lead=\{l\} \/><PublishedEmailProvenance lead=\{l\} \/><\/div>/)
  // #1832: a research-only row whose hold puts the company itself in doubt still shows the published email, display only
  assert.match(client, /part === 'research' && !l\.quarantined_at && !peopleSearchable\(l\.review_reason\) && <div className="text-xs"><PublishedEmailProvenance lead=\{l\} \/><\/div>/)
})
