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

test('#1715 Leads renders customer-facing labels for source review, reported events and a saved profile', () => {
  assert.doesNotMatch(page, /Manually supplied claim|Saved signal claim|carried from a saved profile/i)
  assert.match(page, /source_review_required: 'Review the source\./)
  assert.match(page, /Reported event:/)
  assert.match(page, /from your saved profile\. Approval for this search isn’t recorded/)
})

for (const [file, label] of [
  ['evidence-recheck', 'Recheck saved source (free)'],
  ['page-signals', 'Read passages about finding customers (free)'],
  ['qualify-preview', 'See what a fit check would read (free)'],
]) {
  test(`#1715 ${file} shows the free action without implementation jargon`, () => {
    const component = readFileSync(new URL(`../app/app/leads/${file}.tsx`, import.meta.url), 'utf8')
    assert.equal(component.includes('no AI call'), false)
    assert.ok(component.includes(label))
  })
}

test('#1715 a shared review reason does not attribute scan results to the customer', () => {
  const label = page.match(/source_review_required: '([^']+)'/)?.[1]
  assert.ok(label)
  assert.doesNotMatch(label, /you provided|you supplied/i)
  assert.match(label, /^Review the source\./)
})
