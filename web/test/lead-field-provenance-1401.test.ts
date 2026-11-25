import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

register('./helpers/tsx-loader.mjs', import.meta.url)
const loadFields = () => import('../app/app/leads/field-provenance.tsx')
const client = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')

const website = 'company.example'
const signalUrl = 'https://news.example/event'
const websiteSource = 'https://company.example/about'
const personSource = 'https://company.example/team'
const emailSource = 'https://company.example/contact'
const email = 'sample.buyer@' + website
const enrichment = (connector: string, kind: string, value: string, source_url: string, label: string | null = null) =>
  ({ connector, kind, value, source_url, label })

test('the card renders website, contact and email provenance next to the fields', () => {
  assert.match(client, /<WebsiteProvenance lead=\{l\}/)
  assert.match(client, /<FieldSource field="Contact" source=/)
  assert.match(client, /<PublishedEmailProvenance lead=\{l\}/)
})

test('a stored website has a distinct provenance link or an explicit missing source', async () => {
  const { WebsiteProvenance } = await loadFields()
  const lead = { company_domain: website, source_url: signalUrl, enrichments: [
    enrichment('sitecrawl', 'domain', website + '|name_probe', websiteSource, 'domain-basis-v1:name_probe'),
  ] }
  const html = renderToStaticMarkup(createElement(WebsiteProvenance, { lead }))
  assert.match(html, /href="https:\/\/company\.example\/about"/)
  assert.doesNotMatch(html, /news\.example|verified/)
  const wrongCompany = { ...lead, enrichments: [
    enrichment('sitecrawl', 'domain', 'other.example|name_probe', 'https://other.example/about', 'domain-basis-v1:name_probe'),
  ] }
  const unsupported = renderToStaticMarkup(createElement(WebsiteProvenance, { lead: wrongCompany }))
  assert.match(unsupported, /Website source unavailable/)
  assert.doesNotMatch(unsupported, /other\.example/)
})

test('contact provenance points to the person page and rejects unsupported URLs', async () => {
  const { FieldSource } = await loadFields()
  const html = renderToStaticMarkup(createElement(FieldSource, { field: 'Contact', source: personSource }))
  assert.match(html, /href="https:\/\/company\.example\/team"/)
  const missing = renderToStaticMarkup(createElement(FieldSource, { field: 'Contact', source: 'javascript:alert(1)' }))
  assert.match(missing, /Contact source unavailable/)
  assert.doesNotMatch(missing, /href=/)
})

test('the published email cites its own page even on a lead with no other people details', async () => {
  const { PublishedEmailProvenance } = await loadFields()
  const lead = { source_kind: 'discover', name: 'Sample Buyer', company_domain: website, source_url: signalUrl,
    contact: null, enrichments: [enrichment('discover', 'email', email, emailSource)] }
  const html = renderToStaticMarkup(createElement(PublishedEmailProvenance, { lead }))
  assert.match(html, /sample\.buyer@company\.example/)
  assert.match(html, /href="https:\/\/company\.example\/contact"/)
  assert.doesNotMatch(html, /news\.example|verified/)
  const broker = { ...lead, enrichments: [enrichment('hunter', 'email', email, 'https://broker.example/record')] }
  const unsupported = renderToStaticMarkup(createElement(PublishedEmailProvenance, { lead: broker }))
  assert.match(unsupported, /Published work email unavailable/)
  assert.doesNotMatch(unsupported, /broker\.example|sample\.buyer/)
})
