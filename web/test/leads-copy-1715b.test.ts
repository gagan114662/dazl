import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dropReasonText, dropReasonsLine } from '../lib/leads/drop-reasons-copy.ts'

// #1715 (prod live check, 222420af): 'Dropped: 1 page no longer exists.' / 'Dropped: 4 page no longer exists.'
// - the count and the phrase disagreed. Every drop reason renders as a complete, plural-correct plain phrase.
const SINGULAR: Record<string, string> = {
  excerpt_not_on_page: '1 quote was not on the page',
  no_excerpt: '1 page had no usable quote',
  entity_mismatch: '1 quote did not name the company',
  no_company: '1 page had no company name',
  stale: '1 page was older than 12 months',
  date_conflict: '1 page showed an older date',
  future_date: '1 date was in the future',
  bad_date: '1 date could not be read',
  low_confidence: '1 check was not certain enough',
  contradicted: '1 page contradicted the claim',
  claim_unclear: '1 page did not clearly support the claim',
  page_unreachable: '1 page could not be loaded',
  page_not_found: '1 page was gone',
  source_cap: '1 quote was over the 3-per-page cap',
  url_refused: '1 address was unsafe or unsupported',
  duplicate: '1 company was a duplicate',
}
const PLURAL: Record<string, string> = {
  excerpt_not_on_page: '4 quotes were not on the page',
  no_excerpt: '4 pages had no usable quote',
  entity_mismatch: '4 quotes did not name the company',
  no_company: '4 pages had no company name',
  stale: '4 pages were older than 12 months',
  date_conflict: '4 pages showed an older date',
  future_date: '4 dates were in the future',
  bad_date: '4 dates could not be read',
  low_confidence: '4 checks were not certain enough',
  contradicted: '4 pages contradicted the claim',
  claim_unclear: '4 pages did not clearly support the claim',
  page_unreachable: '4 pages could not be loaded',
  page_not_found: '4 pages were gone',
  source_cap: '4 quotes were over the 3-per-page cap',
  url_refused: '4 addresses were unsafe or unsupported',
  duplicate: '4 companies were duplicates',
}

test('#1715b: every drop reason is plural-correct plain words', () => {
  for (const [reason, text] of Object.entries(SINGULAR)) assert.equal(dropReasonText(reason, 1), text, reason)
  for (const [reason, text] of Object.entries(PLURAL)) assert.equal(dropReasonText(reason, 4), text, reason)
})

test('#1715b: the dropped line joins reasons and never prints a raw key', () => {
  assert.equal(dropReasonsLine({ page_not_found: 1 }), 'Dropped: 1 page was gone.')
  assert.equal(dropReasonsLine({ page_not_found: 4 }), 'Dropped: 4 pages were gone.')
  assert.equal(dropReasonsLine({ page_not_found: 1, duplicate: 2 }), 'Dropped: 1 page was gone, 2 companies were duplicates.')
  assert.equal(dropReasonsLine({ some_new_reason: 3 }), 'Dropped: 3 leads were dropped for another reason.')
  assert.equal(dropReasonsLine({}), '')
})

const research = readFileSync(new URL('../app/app/leads/play-research.tsx', import.meta.url), 'utf8')

test('#1715b: the play research intro says the same honest thing in plain words', () => {
  assert.ok(research.includes('Extra research you saved to this play, separate from this scan'))
  assert.ok(research.includes('We have not checked that these companies fit, want to buy, or agreed to be contacted'))
  assert.ok(research.includes('A professional contact link is not an email address you can send to.'))
  assert.ok(research.includes('cannot approve, draft to, send to, or count these cards as qualified leads'))
  assert.ok(!research.includes('Supplemental research'), 'the stiff label is gone')
  assert.ok(!research.includes('No verified fit, buying intent or consent'), 'the stiff summary is gone')
  assert.ok(!research.includes('Professional contact links are not email recipients'), 'the stiff recipient line is gone')
  assert.ok(!research.includes('Exact quote checks only, not qualification'), 'the stiff save-form line is gone')
  assert.ok(research.includes('that does not make the company a qualified lead'))
  assert.ok(!research.includes('Literal checks do not verify the claim'), 'the stiff check line is gone')
  assert.ok(research.includes('Matching the quote word for word does not prove the claim is true.'))
})
