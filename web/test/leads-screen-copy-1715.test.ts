import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as leadsView from '../lib/scan/leads-view.ts'

const page = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')

test('#1715 saved profile copy points to Review profile first', () => {
  assert.doesNotMatch(page, /Review it in Build/)
  assert.match(page, /Use Review profile first to build a new one from your sentence/)
})

test('#1715 research reasons and timing notes read as separate sentences', () => {
  assert.match(page, /\{reviewTimingCopy\(/)
  const reason = 'Literal source checks do not verify buying need or consent'
  const note = 'This is the day the search index dates the page.'
  assert.equal(leadsView.reviewTimingCopy(reason, note), reason + '. ' + note)
  assert.equal(leadsView.reviewTimingCopy(reason + '.', null), reason + '.')
})

test('#1715 Ready cards render one plain timing message from the saved timing state', () => {
  assert.match(page, /const timing = l\.timing === 'proof_backed' \? timingHeadline\(\{ timing: l\.timing \}\) : c\.timing/)
  assert.match(page, /data-testid="card-timing">\{timing\}/)
  assert.doesNotMatch(page, /data-testid="timing-proof"|\(timing proof-backed\)/)
})
