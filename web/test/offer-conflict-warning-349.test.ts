// #349: a request that states an offer different from the saved profile is flagged in the form before Find leads
// runs, not only after the server refuses it. Quest's prod live check (2a148c60) found no warning before submitting:
// saved "a B2B sales-automation SaaS to small marketing agencies", typed "I sell appointment booking and reminder
// software for dental practices ...".
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { preSubmitOfferWarning } from '../app/app/leads/website-review-offer.ts'

const saved = {
  offer: 'a B2B sales-automation SaaS to small marketing agencies',
  business: 'dazl',
  seller: 'a B2B sales-automation SaaS to small marketing agencies',
}
const page = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')

test('#349 a request stating a different offer than the saved profile warns before submit', () => {
  const w = preSubmitOfferWarning(
    'I sell appointment booking and reminder software for dental practices. Find NYC dental practices that opened a new location in the past 90 days.',
    saved,
  )
  assert.ok(w, 'expected a pre-submit warning')
  assert.match(w.stated.toLowerCase(), /appointment|booking|reminder/)
  assert.match(w.saved.toLowerCase(), /marketing/)
})

test('#349 control: a request that names no conflicting offer does not warn', () => {
  // a plain target request over the saved offer's own buyers is not a conflict
  assert.equal(preSubmitOfferWarning('Find small marketing agencies in London that are hiring SDRs', saved), null)
  // stating the saved offer itself (same wording) is a match, not a conflict
  assert.equal(preSubmitOfferWarning('Sell a B2B sales-automation SaaS to small marketing agencies; find London agencies', saved), null)
})

test('#349 the page renders the pre-submit warning and loads the saved profile once', () => {
  assert.match(page, /data-testid="offer-conflict-warning"/)
  assert.match(page, /preSubmitOfferWarning\(query, savedProfile\)/)
  assert.match(page, /fetch\('\/api\/settings\/profile'\)/)
})
