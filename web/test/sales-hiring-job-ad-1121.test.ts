// #1121 (dogfood on prod 03f0e8eb): dazl's own play "B2B SaaS founders in the US and Canada hiring their first SDR or salesperson" found 7 leads,
// every one an SDR job ad, and held 6 of them as no_sales_hiring_evidence. Two causes, both covered here with the real saved quotes:
//  1. a requested "SDR" never matched a posting titled "Sales Development Representative" (and the same for BDR, AE, salesperson);
//  2. the lead's own job-ad quote names the vacancy without a hiring verb, so the clause reading never counted it.
// Pure functions only (no database): the gate-level pass is in sales-hiring-gate.test.ts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { jobAdQuoteRole, titleIsRole } from '../lib/scan/sales-hiring-gate.ts'
import { requestedHiringRoles, matchedHiringRole } from '../lib/scan/hiring-role-match.ts'

const PLAY = 'B2B SaaS founders in the US and Canada hiring their first SDR or salesperson'
const roles = requestedHiringRoles(PLAY)

test('#1121 the play asks for two roles: SDR and salesperson', () => {
  assert.deepEqual(roles.map(r => r.term), ['SDR', 'salesperson'])
})

test('#1121 a requested SDR / BDR / AE / salesperson matches the written-out title, and the reverse; adjacent roles still do not', () => {
  assert.equal(matchedHiringRole('Sales Development Representative', roles)?.term, 'SDR')
  assert.equal(matchedHiringRole('Founding Sales Development Representative (SDR)', roles)?.term, 'SDR')
  assert.equal(matchedHiringRole('Sales Development Reps', roles)?.term, 'SDR')
  assert.equal(matchedHiringRole('Inside Sales Representative', roles)?.term, 'salesperson')
  const longForm = requestedHiringRoles('startups hiring a sales development representative')
  assert.equal(matchedHiringRole('SDR, North America', longForm)?.term, 'sales development representative')
  const bdr = requestedHiringRoles('companies hiring a BDR'), ae = requestedHiringRoles('companies hiring an AE')
  assert.equal(matchedHiringRole('Business Development Representative', bdr)?.term, 'BDR')
  assert.equal(matchedHiringRole('Enterprise Account Executive', ae)?.term, 'AE')
  // an SDR is not an AE, a BDR, a plain sales representative, or a manager of SDRs
  for (const t of ['Account Executive', 'Business Development Representative', 'Sales Engineer', 'Sales Operations Manager']) assert.equal(matchedHiringRole(t, requestedHiringRoles('companies hiring an SDR')), null, t)
  assert.equal(matchedHiringRole('Sales Development Representative', requestedHiringRoles('companies hiring a sales representative')), null)
  // broad hiring is still not a named title
  assert.deepEqual(requestedHiringRoles('Find companies hiring sales people'), [])
})

test('#1121 the title shape rule finds the role in its written-out form', () => {
  for (const t of ['Sales Development Representative', 'Founding Sales Development Representative (SDR)', 'Senior Sales Development Representative, East', 'SDR']) assert.ok(titleIsRole(t, roles), t)
  for (const t of ['Sales Development Representative Manager', 'Manager, Sales Development Representatives', 'Sales Development Representative Internship']) assert.equal(titleIsRole(t, roles), null, t)
})

test('#1121 PASS: the real saved job-ad quotes name the requested vacancy for the lead\'s own company', () => {
  for (const [quote, company] of [
    ["As a Sales Development Representative at Mercury, you'll be the first point of contact for founders...", 'Mercury'],
    ['Sales Development Representative (SDR) New York City Full-Time On-Site About Clark...', 'Clark'],
    ['Founding Sales Development Representative (SDR) Chesky United States', 'Chesky'],
  ] as const) {
    assert.equal(jobAdQuoteRole(quote, company, roles)?.term, 'SDR', quote)
    assert.ok(jobAdQuoteRole(quote, company, []), `generic sales request: ${quote}`)
  }
})

test('#1121 HELD: no vacancy title, another company, a negation, the wrong title shape or a non-requested role is not proof', () => {
  for (const [why, quote, company] of [
    ['no role title, only work described (beehiiv)', 'This role focuses on driving sales growth by generating qualified meetings for AEs through effective cold calling', 'beehiiv'],
    ['a title that is not the role\'s own shape (Ngenaire contractor ad)', 'B2B SaaS Sales Representative (High Commission-Based Contractor) at Ngenaire • Toronto • Remote', 'Ngenaire'],
    ['another company\'s ad', 'As a Sales Development Representative at Othercorp, you will book meetings', 'Mercury'],
    ['the company not named at all', 'Sales Development Representative (SDR) New York City Full-Time', 'Clark'],
    ['a company name only inside a longer word', 'Sales Development Representative at Mercurylabs', 'Mercury'],
    ['negated', 'Mercury is not hiring a Sales Development Representative', 'Mercury'],
    ['past', 'Sales Development Representative at Mercury was filled previously', 'Mercury'],
    ['a manager of the role', 'Sales Development Representative Manager at Mercury', 'Mercury'],
    ['a hiring sentence, not an ad heading (the clause reading decides those)', 'Mercury is hiring a Sales Development Representative', 'Mercury'],
    ['a different role than requested', 'Account Executive at Mercury', 'Mercury'],
    ['empty quote', '', 'Mercury'],
  ] as const) assert.equal(jobAdQuoteRole(quote, company, roles), null, why)
})

// review at 541c6f4e (Ziggy F1): the words after a bracketed abbreviation are part of the title. A manager, an internship or a talent community
// behind "(SDR)" is another title and is never turned into SDR proof; the real ad headings that run on into their place still pass.
test('#1121 F1 HELD: a title suffix after the abbreviation is kept and judged (manager, internship, talent community)', () => {
  for (const [quote, company] of [
    ['Sales Development Representative (SDR) Manager at Mercury', 'Mercury'],
    ['Sales Development Representative (SDR) Internship at Mercury', 'Mercury'],
    ['Sales Development Representative (SDR) Talent Community at Mercury', 'Mercury'],
    ['Sales Development Representative (SDR) Manager New York City Full-Time About Clark', 'Clark'],
  ] as const) {
    assert.equal(jobAdQuoteRole(quote, company, roles), null, quote)
    assert.equal(jobAdQuoteRole(quote, company, []), null, `generic: ${quote}`)
  }
  for (const t of ['Sales Development Representative (SDR) Manager', 'Sales Development Representative (SDR) Internship', 'Sales Development Representative (SDR) Talent Community']) assert.equal(titleIsRole(t, roles), null, t)
})

// review at f4c751e3 (Hermes F1): the suffix is judged as a whole title, not by its first word; a modifier before the title word still refuses
test('#1121 F1 HELD: a modified title suffix (Senior Manager, Sr. Director, Sales Manager ...) is refused, specific and generic', () => {
  for (const [quote, company] of [
    ['Sales Development Representative (SDR) Senior Manager at Mercury', 'Mercury'],
    ['Sales Development Representative (SDR) Sr. Director at Mercury', 'Mercury'],
    ['Sales Development Representative (SDR) Associate Team Lead at Mercury', 'Mercury'],
    ['Sales Development Representative (SDR) Sales Manager at Mercury', 'Mercury'],
    ['Sales Development Representative (SDR) Global Head New York City Full-Time About Clark', 'Clark'],
  ] as const) {
    assert.equal(jobAdQuoteRole(quote, company, roles), null, quote)
    assert.equal(jobAdQuoteRole(quote, company, []), null, `generic: ${quote}`)
  }
  assert.ok(jobAdQuoteRole('Sales Development Representative (SDR) New York City Full-Time On-Site About Clark', 'Clark', roles))
  assert.ok(jobAdQuoteRole('Founding Sales Development Representative (SDR) Chesky United States', 'Chesky', roles))
})

// review at 06969a58 (Hermes F1): a separator before the modified suffix ("- Senior Manager", "/ Sales Manager") must not bypass the
// suffix guard on the whole-title path; the same refusal applies before either successful return
test('#1121 F1 (06969a58) HELD: a separator-prefixed modified title suffix is refused, specific and generic', () => {
  for (const [quote, company] of [
    ['Sales Development Representative (SDR) - Senior Manager at Mercury', 'Mercury'],
    ['Sales Development Representative (SDR) / Sales Manager at Mercury', 'Mercury'],
    ['Sales Development Representative - Senior Manager at Mercury', 'Mercury'],
    ['Sales Development Representative (SDR) – Sr. Director at Mercury', 'Mercury'],
  ] as const) {
    assert.equal(jobAdQuoteRole(quote, company, roles), null, quote)
    assert.equal(jobAdQuoteRole(quote, company, []), null, `generic: ${quote}`)
  }
  assert.ok(jobAdQuoteRole('Sales Development Representative (SDR) New York City Full-Time On-Site About Clark', 'Clark', roles))
  assert.ok(jobAdQuoteRole('Founding Sales Development Representative (SDR) Chesky United States', 'Chesky', roles))
  assert.ok(jobAdQuoteRole('As a Sales Development Representative at Mercury, you will book meetings', 'Mercury', roles))
})
