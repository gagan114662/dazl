import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requestedGateRoles, titleIsRole } from '../lib/scan/sales-hiring-gate.ts'
import { matchedHiringRole, requestedHiringRoles } from '../lib/scan/hiring-role-match.ts'

// Run d84a33a0 (prod 87505c47): Knack's Greenhouse posting 4479605009 "Sales Account Executive" (2026-11-04) was held as
// no_sales_hiring_evidence for case 1, which asks for "hiring their first SDR/BDR or sales rep". An account executive IS a sales rep:
// a request for a generic sales rep / salesperson accepts AE titles. One way only: a request for an AE does not accept "Sales Representative",
// and SDR / BDR stay distinct from AE.
const CASE1 = 'Find B2B companies (5-200 employees) doing outbound sales that show a dated buying signal in the last 45 days: hiring their first SDR/BDR or sales rep, new funding, a new Head of Sales/VP Sales, or a founder still doing sales. Buyer: Founder, CEO or Head of Sales. seller = dazl (dazl.ai): AI that finds high-intent leads and drafts reviewed cold outreach from your own Gmail.'
test('d84a33a0 Knack: "Sales Account Executive" is the requested sales rep for case 1', () => {
  const rs = requestedGateRoles(CASE1, null)
  assert.equal(matchedHiringRole('Sales Account Executive', rs)?.normalized, 'salesperson')
  assert.ok(titleIsRole('Sales Account Executive', rs), 'the gate reads the title as the role itself')
  assert.ok(titleIsRole('Account Executive, Mid-Market', rs))
})
test('d84a33a0: the widening is one way and bounded', () => {
  const ae = requestedHiringRoles('hiring account executives')
  assert.equal(matchedHiringRole('Sales Representative', ae), null, 'an AE request is not answered by a sales rep posting')
  const sdr = requestedHiringRoles('hiring SDRs')
  assert.equal(matchedHiringRole('Account Executive', sdr), null, 'an SDR is not an AE')
  const rep = requestedHiringRoles('hiring sales reps')
  assert.equal(matchedHiringRole('Account Executive Manager', rep) && titleIsRole('Account Executive Manager', rep), null, 'a manager title is not the rep')
})
