import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import * as websiteReview from '../app/app/leads/website-review-offer.ts'

const savedBuyer = { summary: 'Cleaning agencies', who: ['Cleaning agencies'], exclude: ['Existing customers'] }

function submitSearch(query: string) {
  const client = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
  const selection = /^  const startIcp = .+$/m.exec(client)?.[0]
  const requestProfile = /^  const requestProfile = .+$/m.exec(client)?.[0]
  const submit = /<form onSubmit=\{e => \{ (.+?) \}\} className=/.exec(client)?.[1]
  assert.ok(selection, 'locate the profile selection used by the lead search')
  assert.ok(submit, 'locate the Find leads submit handler')

  const submitted: unknown[][] = []
  runInNewContext(`${selection}\n${requestProfile ?? ''}\n${submit}`, {
    query,
    priorIcp: null,
    savedBuyer,
    startReviewed: false,
    openWebsiteDraft: null,
    e: { preventDefault() {} },
    ...websiteReview,
    run: (...args: unknown[]) => submitted.push(args),
  })

  return submitted
}

test('#349: a dental request does not submit the saved cleaning profile for confirmation', () => {
  assert.deepEqual(submitSearch('Find dental clinics in Toronto'), [[null, undefined, undefined, ['Existing customers']]])
})

for (const query of [
  'Find customers in my area',
  'Companies in Toronto',
  'Find customers in Toronto',
  'Find businesses in Toronto',
  'Find clients in Toronto',
  'Find buyers in Toronto',
  'Find accounts in Toronto',
  'Find people in Toronto',
  'Find dental clinics in my area',
  'Find dental clinics near me',
]) {
  test(`#349: "${query}" submits the saved profile for confirmation`, () => {
    assert.deepEqual(submitSearch(query), [[savedBuyer, undefined, false]])
  })
}

test('#349: a generic request and an exact reviewed repeat keep their existing carry path', () => {
  const saved = { summary: 'Cleaning agencies', who: ['Cleaning agencies'], industries: [], sizes: [], where: [], signals: [], exclude: [] }
  const reviewed = { ...saved, summary: 'Dental clinics in Toronto', who: ['Dental clinics'], where: ['Toronto'] }
  assert.equal(websiteReview.requestConfirmationProfile('Find leads in Toronto', null, saved), null)
  assert.equal(websiteReview.requestConfirmationProfile('Companies in need of new suppliers', null, saved), null)
  assert.equal(websiteReview.requestConfirmationProfile('Find dental clinics in Toronto', reviewed, saved), null)
})

test('#349: Fo’s dentist request shows typed targeting and hides the saved-profile summary', () => {
  const query = 'Dentists in Toronto that are hiring'
  assert.deepEqual(submitSearch(query), [[null, undefined, undefined, ['Existing customers']]])

  const client = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
  assert.match(client, /requestProfile &&[^\n]*data-testid="request-target"[^\n]*\{query\}/)
  assert.match(client, /!requestProfile && businessIcp &&[^\n]*data-testid="business-profile"/)
})

test('#349: an unrelated new buyer and market use the same targeting path', () => {
  assert.deepEqual(submitSearch('Veterinary practices in Chicago opening new locations'),
    [[null, undefined, undefined, ['Existing customers']]])
})
