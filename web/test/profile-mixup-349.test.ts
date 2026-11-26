import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import * as websiteReview from '../app/app/leads/website-review-offer.ts'

test('#349: a dental request does not submit the saved cleaning profile for confirmation', () => {
  const client = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
  const selection = /^  const startIcp = .+$/m.exec(client)?.[0]
  const requestProfile = /^  const requestProfile = .+$/m.exec(client)?.[0]
  const submit = /<form onSubmit=\{e => \{ (.+?) \}\} className=/.exec(client)?.[1]
  assert.ok(selection, 'locate the profile selection used by the lead search')
  assert.ok(submit, 'locate the Find leads submit handler')

  const submitted: unknown[][] = []
  runInNewContext(`${selection}\n${requestProfile ?? ''}\n${submit}`, {
    query: 'Find dental clinics in Toronto',
    priorIcp: null,
    savedBuyer: { summary: 'Cleaning agencies', who: ['Cleaning agencies'], exclude: ['Existing customers'] },
    startReviewed: false,
    openWebsiteDraft: null,
    e: { preventDefault() {} },
    ...websiteReview,
    run: (...args: unknown[]) => submitted.push(args),
  })

  assert.deepEqual(submitted, [[null, undefined, undefined, ['Existing customers']]])
})

test('#349: a generic request and an exact reviewed repeat keep their existing carry path', () => {
  const saved = { summary: 'Cleaning agencies', who: ['Cleaning agencies'], industries: [], sizes: [], where: [], signals: [], exclude: [] }
  const reviewed = { ...saved, summary: 'Dental clinics in Toronto', who: ['Dental clinics'], where: ['Toronto'] }
  assert.equal(websiteReview.requestConfirmationProfile('Find leads in Toronto', null, saved), null)
  assert.equal(websiteReview.requestConfirmationProfile('Companies in need of new suppliers', null, saved), null)
  assert.equal(websiteReview.requestConfirmationProfile('Find dental clinics in Toronto', reviewed, saved), null)
})
