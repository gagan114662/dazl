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
