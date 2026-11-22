import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ashbyOrgWebsite } from '../lib/connectors/sitecrawl.ts'

// Run 679a7354: n8n and Mintlify held no_company_domain; their postings never write out a domain. Each Ashby posting page (saved live
// 2026-11-21) carries the employer's own organization setting "publicWebsite" - the company's own statement, bound like a link.
const fx = (f: string) => readFileSync(new URL(`./fixtures/ashby-site/${f}`, import.meta.url), 'utf8')
test('the employer\'s own Ashby website setting names its domain (n8n, Mintlify)', () => {
  assert.equal(ashbyOrgWebsite(fx('n8n.html'), 'n8n'), 'n8n.io')
  assert.equal(ashbyOrgWebsite(fx('mintlify.html'), 'Mintlify'), 'mintlify.com')
})
test('holds: another company\'s page, a website whose name differs, a social or missing setting is nothing', () => {
  assert.equal(ashbyOrgWebsite(fx('mintlify.html'), 'n8n'), null)
  const org = (name: string, site: string | null) => `<script>window.__appData = {"organization":{"name":${JSON.stringify(name)},"publicWebsite":${JSON.stringify(site)}}}</script>`
  assert.equal(ashbyOrgWebsite(org('Acme', 'https://othername.com'), 'Acme'), null)
  assert.equal(ashbyOrgWebsite(org('Acme', 'https://linkedin.com/company/acme'), 'Acme'), null)
  assert.equal(ashbyOrgWebsite(org('Acme', null), 'Acme'), null)
  assert.equal(ashbyOrgWebsite(org('Other Co', 'https://acme.com'), 'Acme'), null)
})
