import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { atsRecord, atsPostingRef } from '../lib/sources/ats-posting.ts'
import { recordCompanyDomain } from '../lib/connectors/sitecrawl.ts'

// Uare.ai held no_company_domain (Greenhouse job-boards.greenhouse.io/uareai). Its board sets no website (logo href null) and the
// postings never write out a link; the employer's own Greenhouse record names the company "Uare.ai" - a domain. Saved live 2026-11-22.
const ref = atsPostingRef('https://job-boards.greenhouse.io/uareai/jobs/4459499009')!
const rec = atsRecord(JSON.parse(readFileSync(new URL('./fixtures/gh-site/uareai-4459499009.json', import.meta.url), 'utf8')), ref)
test('the employer\'s own Greenhouse company name that IS a domain names its website (Uare.ai -> uare.ai)', () => {
  assert.ok(rec && rec !== 'missing')
  assert.equal(recordCompanyDomain(rec.company, 'Uare.ai'), 'uare.ai')
})
test('holds: a plain name, another company, a different lead name, a social host give nothing', () => {
  assert.equal(recordCompanyDomain('Uare', 'Uare'), null)
  assert.equal(recordCompanyDomain('Other.ai', 'Uare.ai'), null)
  assert.equal(recordCompanyDomain('Uare.ai', 'Uare'), null)
  assert.equal(recordCompanyDomain('linkedin.com', 'linkedin.com'), null)
})
