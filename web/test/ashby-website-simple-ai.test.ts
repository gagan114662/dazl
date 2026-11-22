import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ashbyOrgWebsite } from '../lib/connectors/sitecrawl.ts'

// Run d84a33a0: Simple AI's Ashby posting 62c2ff65 (Head of Sales, 2026-11-12; page saved 2026-11-22) was held no_company_domain. Its own
// organization record says {"name":"Simple AI","publicWebsite":"https://www.usesimple.ai/"}: the label "usesimple" plus the suffix "ai"
// is "use" + the company's name. That is the employer's own setting; the homepage name check still decides.
const html = readFileSync(new URL('./fixtures/simple-ai/ashby-62c2ff65.html', import.meta.url), 'utf8')
test('d84a33a0 Simple AI: the Ashby record binds usesimple.ai', () => {
  assert.equal(ashbyOrgWebsite(html, 'Simple AI'), 'usesimple.ai')
})
test('d84a33a0: the widening is bounded to a use/get/try/join prefix and the name with its suffix', () => {
  const rec = (name: string, site: string) => `"organization":{"name":"${name}","publicWebsite":"${site}"}`
  assert.equal(ashbyOrgWebsite(rec('Acme', 'https://getacme.com'), 'Acme'), 'getacme.com')
  assert.equal(ashbyOrgWebsite(rec('Simple AI', 'https://simplehealth.ai'), 'Simple AI'), null)
  assert.equal(ashbyOrgWebsite(rec('Simple AI', 'https://usesomething.ai'), 'Simple AI'), null)
  assert.equal(ashbyOrgWebsite(rec('Other Co', 'https://useacme.com'), 'Acme'), null, 'the record must be this company')
})
