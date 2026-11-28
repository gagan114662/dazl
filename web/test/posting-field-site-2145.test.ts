import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as sc from '../lib/connectors/sitecrawl.ts'

// #2145: a posting's template field "Website" (dt/dd or table row) names the employer's site; a "Website:" sentence in running text does not.
const wrap = (b: string) => `<html><body><h1>Tax Accountant</h1><p>Birchwood Tax LLP is hiring in Calgary.</p>${b}</body></html>`
const find = (b: string) => sc.findCompanySitesWithBasis('Birchwood Tax LLP', wrap(b), 'https://jobs.example-board.ca/job/1').map(o => o.site)

test('#2145 a Website field in a dt/dd pair or a table row names the employer site', () => {
  assert.deepEqual(find('<dl><dt>Website:</dt><dd>bwlp.ca</dd></dl>'), ['bwlp.ca'])
  assert.deepEqual(find('<dl><dt>Website</dt><dd><a href="https://www.bwlp.ca/">www.bwlp.ca</a></dd></dl>'), ['bwlp.ca'])
  assert.deepEqual(find('<table><tr><th>Employer website</th><td>bwlp.ca</td></tr></table>'), ['bwlp.ca'])
})

test('#2145 control: a Website sentence in running text is not a field (the Job Bank scoping guard)', () => {
  assert.deepEqual(find('<p>Website: bwlp.ca</p>'), [])
  assert.deepEqual(find('<ul><li>Website: bwlp.ca</li></ul>'), [])
  assert.deepEqual(find('<p>Our Website</p><p>bwlp.ca</p>'), [])
})

test('#2145 control: a field naming a social, board or government host is not taken', () => {
  assert.deepEqual(find('<dl><dt>Website</dt><dd>linkedin.com</dd></dl>'), [])
  assert.deepEqual(find('<dl><dt>Website</dt><dd>jobs.example-board.ca</dd></dl>'), [])
  assert.deepEqual(find('<dl><dt>Contact</dt><dd>bwlp.ca</dd></dl>'), [])
})

// The header card of a provincial association's job board (markup read by Gagan's QA on 2026-11-27, firm names kept as printed there):
// a <dl class="grid"> of label/value pairs inside wrapper divs, the label text padded with whitespace, the value a classless link.
const CARD = (label: string) => `<div class="block--larger card highlight-lighter"><dl class="grid">
  <div class="cf margin-bottom-5 job-detail-description__recruiter">
    <dt class="grid-item two-fifths portable-one-whole palm-one-half">Employer</dt>
    <dd class="grid-item three-fifths portable-one-whole palm-one-half"><a href="/employer/203842/l-bloxham-professional-corporation/"><span>L Bloxham Professional Corporation</span></a></dd>
  </div>
  <div class="cf margin-bottom-5 job-detail-description__website-upsell">
    <dt class="grid-item two-fifths portable-one-whole palm-one-half">
      ${label}
    </dt>
    <dd class="grid-item three-fifths portable-one-whole palm-one-half">
      <a href="https://www.lbpccpa.ca/" target="_blank">https://www.lbpccpa.ca/</a>
    </dd>
  </div>
  <div class="cf margin-bottom-5 job-detail-description__location">
    <dt class="grid-item two-fifths portable-one-whole palm-one-half">Location</dt>
    <dd class="grid-item three-fifths portable-one-whole palm-one-half"><span>Calgary (City), Alberta</span></dd>
  </div></dl></div>`
const cardSites = (label: string) => sc.findCompanySitesWithBasis('L Bloxham Professional Corporation', `<html><body>${CARD(label)}</body></html>`, 'https://jobs.cpaalberta.ca/job/2000742/senior-staff-accountant/?TrackID=10')

test('#2145 the header card shape: a whitespace-padded "Website" dt with a classless link in the dd names the employer site', () => {
  assert.deepEqual(cardSites('Website'), [{ site: 'lbpccpa.ca', basis: 'evidence_link_text', structured: true }])
})

test('#2145 control: the same card without a Website label gives no site (the Employer link is the board\'s own profile page)', () => {
  assert.deepEqual(cardSites('Salary'), [])
})
