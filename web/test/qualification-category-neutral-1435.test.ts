// #1435 "Prompt and identity vocabulary": the lead-qualification prompt and its customer-sector diagnostic were written for
// one market. The fixed prompt text taught a rule about "B2B SaaS" and "software companies", and the diagnostic only ran
// when the target criteria said "B2B SaaS/software" and the model's note compared against "software companies". Every
// other market got neither the rule nor the warning. Retired baseline: the "B2B SaaS describes the TARGET company's own
// software business..." and "Existing CRM or in-house tools ... setup help or consulting" prompt sentences, the /\bb2b\s+(?:saas|software)\b/ criteria gate, and the
// "software companies|businesses buying software services" premise list in lib/scan/lead-qualify.ts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseQualification, preparePrompt } from '../lib/scan/lead-qualify.ts'

// The fixed instruction text, with every caller-supplied field and page left empty.
const fixedText = preparePrompt({ seller_offer: '', seller_icp: '', company: '', signal: '', pages: [{ url: 'https://synthetic.example/', text: 'x' }] }).prompt

test('#1435 the fixed qualification prompt names no market, sector or category', () => {
  assert.doesNotMatch(fixedText, /\bsaas\b|\bsoftware\b|\bb2b\b|\bcrm\b|consulting/i)
  // the general rule it carried is kept, in category-neutral words
  assert.match(fixedText, /what the target itself sells/i)
  assert.match(fixedText, /kind of business its customers are is a separate fact/)
  assert.match(fixedText, /no need for the seller's offer/)
})

const url = 'https://synthetic.example/about', quote = 'We run three clinics and see patients six days a week.'
function grade(criteria: string, note: string, verdict = 'no') {
  const prep = preparePrompt({ seller_offer: 'Scheduling setup', seller_icp: criteria, company: 'Synthetic', signal: 'Opened a clinic', pages: [{ url, text: quote }] })
  return parseQualification(JSON.stringify({ company_fit: { verdict, quote, quote_url: url, note } }), prep.included, prep.scope, criteria).company_fit
}

test('#1435 an unseen category gets the same customer-sector warning: the target is judged on what it is, not on who its customers are', () => {
  for (const [criteria, note] of [
    ['Independent veterinary practices', 'Their customers are pet owners, not veterinary practices.'],
    ['Commercial bakeries with their own retail shops', 'Their customers are walk-in shoppers, not commercial bakeries.'],
    ['Freight forwarders', 'The customers are importers rather than freight forwarders.'],
    // council round 1: a list of customers, and ordinary criteria words ("looking for", "target market") that put no condition on customers
    ['B2B SaaS startups in London', 'The customers are insurers, carriers, and brokers, not software companies.'],
    ['Dental clinics looking for a new booking system', 'Their customers are patients, not dental clinics.'],
    ['Target market: independent veterinary practices', 'Their customers are pet owners, not veterinary practices.'],
    ['Startups that raised funding for expansion in the last 90 days', 'Its customers are hospitals, not startups.'],
  ]) {
    const f = grade(criteria, note)
    assert.equal(f.assessment_conflict?.kind, 'customer_sector_not_target_business', criteria)
    assert.equal(f.verdict, 'no'); assert.equal(f.note, note)   // raw verdict and note unchanged: a warning, never a rewrite
  }
})

test('#1435 controls: criteria that do condition the customers, other grounds, and non-negative verdicts are never flagged', () => {
  // wrong-customer control: the criteria put a condition on who the target sells to, so a customer-sector no is legitimate
  for (const criteria of ['Agencies that sell to hospitals', 'Wholesalers serving restaurants', 'Firms whose customers must be insurers', 'Suppliers targeting municipalities', 'Commercial bakeries supplying cafes', 'Studios providing photography to hotels', 'Consultancies that work with hospitals', 'Agencies whose clients are law firms'])
    assert.equal(grade(criteria, 'Their customers are retailers, not hospitals.').assessment_conflict, undefined, criteria)
  // wrong-company / wrong-place grounds are not a customer premise
  for (const note of ['The page is about another company.', 'Headquarters are outside the target region.', 'Customers include clinics; the target itself is a distributor, not a clinic.'])
    assert.equal(grade('Independent veterinary practices', note).assessment_conflict, undefined, note)
  for (const v of ['yes', 'unknown']) assert.equal(grade('Independent veterinary practices', 'Their customers are pet owners, not veterinary practices.', v).assessment_conflict, undefined, v)
  // no target criteria: nothing to compare against
  const prep = preparePrompt({ seller_offer: 'x', seller_icp: '', company: 'S', signal: 's', pages: [{ url, text: quote }] })
  assert.equal(parseQualification(JSON.stringify({ company_fit: { verdict: 'no', quote, quote_url: url, note: 'Their customers are pet owners, not clinics.' } }), prep.included, prep.scope).company_fit.assessment_conflict, undefined)
})

test('#1435 real recorded paid response (Nettle, preserved fixture) is still flagged, verdicts and quotes unchanged', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/qualification-semantic/nettle-real-response.json', import.meta.url), 'utf8'))
  const prep = preparePrompt(fixture.input, fixture.limits)
  for (const raw of [fixture.raw_model_text, fixture.comparative_response.raw_model_text]) {
    const plain = parseQualification(raw, prep.included, prep.scope), q = parseQualification(raw, prep.included, prep.scope, fixture.input.seller_icp)
    assert.equal(q.company_fit.verdict, 'no'); assert.equal(q.company_fit.quote, plain.company_fit.quote)
    assert.equal(q.company_fit.assessment_conflict?.kind, 'customer_sector_not_target_business')
    assert.deepEqual(q.use_case, plain.use_case); assert.deepEqual(q.buying_evidence, plain.buying_evidence)
  }
})
