import test from 'node:test'
import assert from 'node:assert/strict'
import { effectiveOffer } from '../lib/scan/play-offer-text.ts'

// #349 the one decision matrix for "is this play's request the saved offer?". Saved profile: the NYC dental seller.
// equivalent -> the play uses the saved offer (no question). choice -> the play is contested until the tenant chooses.
// Every row goes through effectiveOffer, the function Home, campaign, drafts, drafting, rewrite and scoring all read.
const SAVED = 'We sell appointment booking and reminder software to independent dental practices in New York City.'
const P = 'appointment booking and reminder software'
type Row = [group: string, request: string, expect: 'equivalent' | 'choice']
const MATRIX: Row[] = [
  // same product, paraphrased or restated
  ['same product', P, 'equivalent'],
  ['same product', `We sell ${P}.`, 'equivalent'],
  ['same product', `we sell ${P.toUpperCase()}.`, 'equivalent'],
  ['same product', `We sell ${P} to independent dental practices in New York City.`, 'equivalent'],
  // descriptive targeting and hiring around the same product
  ['targeting', `Independent dental practices in New York City hiring a front-desk coordinator. We sell ${P}.`, 'equivalent'],
  ['targeting', `Find dental practices in NYC. We sell ${P}. Exclude chains.`, 'equivalent'],
  ['targeting', `Dental practices in NYC hiring a receptionist. We sell ${P}.`, 'equivalent'],
  ['targeting', `Clinics in Leeds who are hiring office managers. We sell ${P}.`, 'equivalent'],
  ['targeting', `Email founders who are hiring. We sell ${P}.`, 'equivalent'],
  ['targeting', `Find agencies in London, Leeds and Manchester. We sell ${P}.`, 'equivalent'],
  // a changed product
  ['changed product', 'We sell CRM setup and outbound consulting.', 'choice'],
  ['changed product', 'Find London SaaS startups hiring their first sales rep. We sell CRM setup and outbound consulting.', 'choice'],
  ['changed product', `We sell ${P} and payroll software.`, 'choice'],
  ['changed product', `We sell ${P}. Selling payroll software to founders.`, 'choice'],
  // a changed buyer stated with the offer
  ['changed buyer', `We sell ${P} to veterinary practices.`, 'choice'],
  ['changed buyer', `We sell ${P} to dental practices in Boston.`, 'choice'],
  // material qualifications: withdrawn services, pricing terms, results, extra services
  ['qualification', `We sell ${P}. Email marketing is unavailable.`, 'choice'],
  ['qualification', `We sell ${P}. Email marketing costs extra.`, 'choice'],
  ['qualification', `We sell ${P}. Contact enrichment requires a paid add-on.`, 'choice'],
  ['qualification', `We sell ${P}. Email marketing won customers.`, 'choice'],
  ['qualification', `We sell ${P}. Payroll is included.`, 'choice'],
  ['qualification', `We sell ${P}, but not outbound consulting.`, 'choice'],
  ['qualification', `We sell ${P}. No SMS reminders.`, 'choice'],
  // unknown places and unparsed descriptions stay material
  ['unknown place', `Independent dental practices in Premium Tiers. We sell ${P}.`, 'choice'],
  ['unknown place', `Email providers in Canada Cost Extra. We sell ${P}.`, 'choice'],
  ['unparsed', `Independent dental practices hiring a coordinator won customers. We sell ${P}.`, 'choice'],
  ['unparsed', `Email marketing agencies. We sell ${P}.`, 'choice'],
  // a request that withdraws the saved offer never resolves to it, with or without a replacement
  ['withdrawn', `We do not sell ${P}.`, 'choice'],
  ['withdrawn', `We no longer sell ${P}.`, 'choice'],
  ['withdrawn', `Find London SaaS startups. We don't sell ${P} anymore.`, 'choice'],
  ['withdrawn', `We have stopped selling ${P}. We sell CRM setup and outbound consulting.`, 'choice'],
  // reworded withdrawals (council review): any position, other subjects, adverbs, no apostrophe, past and stop verbs
  ['withdrawn', `Note: we no longer sell ${P}.`, 'choice'],
  ['withdrawn', `As of May we don't sell ${P}`, 'choice'],
  ['withdrawn', `Our company no longer sells ${P}.`, 'choice'],
  ['withdrawn', `Our team no longer sells ${P}.`, 'choice'],
  ['withdrawn', `We are no longer selling ${P}.`, 'choice'],
  ['withdrawn', `We dont sell ${P}.`, 'choice'],
  ['withdrawn', `We don't currently sell ${P}.`, 'choice'],
  ['withdrawn', `We used to sell ${P}.`, 'choice'],
  ['withdrawn', `We discontinued ${P}.`, 'choice'],
  ['withdrawn', `We have discontinued ${P}.`, 'choice'],
  ['withdrawn', `We do not sell ${P} anymore, we now sell CRM setup and outbound consulting.`, 'choice'],
  ['withdrawn', `Find London SaaS startups: we no longer sell ${P}.`, 'choice'],
  ['withdrawn', `Find London SaaS startups - we no longer sell ${P}.`, 'choice'],
  ['withdrawn', `Find London SaaS startups and we no longer sell ${P}.`, 'choice'],
  ['withdrawn', `Hello we no longer sell ${P} to dental practices.`, 'choice'],
  ['withdrawn', `Find London SaaS startups. We're no longer selling ${P}.`, 'choice'],
  ['withdrawn', `Find London SaaS startups. We've stopped selling ${P}.`, 'choice'],
  // a "do not offer" about something the saved offer does not sell is not a withdrawal of it
  ['withdrawn', 'We no longer sell scheduling tools.', 'choice'],
  ['withdrawn', 'We no longer sell it.', 'choice'],
  ['withdrawn', 'We no longer sell that product.', 'choice'],
  ['withdrawn', 'We stopped selling our dental product.', 'choice'],
  ['unrelated exclusion', 'Find dental practices in NYC hiring. We do not offer free trials.', 'equivalent'],
  ['unrelated exclusion', 'Independent dental practices in New York City hiring a front-desk coordinator. We don\'t provide on-site training.', 'equivalent'],
]

test('#349 decision matrix: equivalents stay equivalent; changed product/buyer, qualifications and unknown places ask for a choice', () => {
  const seller = `${SAVED} - https://seller.example`
  const failures: string[] = []
  const counts: Record<string, Record<string, number>> = {}
  for (const [group, request, expect] of MATRIX) {
    const r = effectiveOffer({ seller, query: request }, '')
    const got = r.source === 'conflict' ? 'choice' : r.offer === SAVED ? 'equivalent' : `other:${r.source}`
    if (got !== expect) failures.push(`${group}: "${request}" expected ${expect}, got ${got}`)
    counts[group] ??= { equivalent: 0, choice: 0 }
    counts[group][expect]++
    // the same answer from the profile path (no play snapshot)
    const viaProfile = effectiveOffer({ seller: null, query: request }, SAVED)
    const gotProfile = viaProfile.source === 'conflict' ? 'choice' : viaProfile.offer === SAVED ? 'equivalent' : `other:${viaProfile.source}`
    if (gotProfile !== expect) failures.push(`${group} (profile path): "${request}" expected ${expect}, got ${gotProfile}`)
  }
  assert.deepEqual(failures, [])
  assert.ok(MATRIX.length >= 25)
  // a choice already made for the play always wins, whatever its request says
  assert.deepEqual(effectiveOffer({ offer: 'CRM setup and outbound consulting', seller: `${SAVED} - https://seller.example`, query: 'We sell CRM setup and outbound consulting.' }, ''),
    { offer: 'CRM setup and outbound consulting', source: 'play', conflict: null })
})

test('#349 decision matrix: a term-only withdrawal still asks when the saved product is that term', () => {
  for (const [saved, q] of [['Sales training for B2B startups.', 'We no longer offer training.'], ['Customer support outsourcing for SaaS companies.', 'We no longer offer support.'],
    ['Live chat software for online shops.', 'We no longer sell live chat.'], ['Employee onboarding software for agencies.', 'We do not offer onboarding.'],
    ['Payment processing for restaurants.', 'We no longer provide payments.'], ['Custom pricing consulting for SaaS.', 'We no longer offer custom pricing.']])
    assert.equal(effectiveOffer({ seller: `${saved} - https://seller.example`, query: q }, '').source, 'conflict', `${saved} / ${q}`)
})
