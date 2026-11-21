import assert from 'node:assert/strict'
import test from 'node:test'
import { affirmativeSalesHiring } from '../lib/scan/sales-hiring-gate.ts'
// Prod run 0dfeb60a (Skopenow): a real SDR posting held no_sales_hiring_evidence because its ad says "join our Sales Development organization".
test('a job ad asking people to join the sales development organization is sales hiring', () => {
  assert.ok(affirmativeSalesHiring('We are looking for high-energy, driven professionals with sound business acumen, strong technical aptitude and natural sales instincts to join our Sales Development organization.', 'Skopenow'))
  assert.ok(!affirmativeSalesHiring('We are not looking for anyone to join our Sales Development organization.', 'Skopenow'))
  assert.ok(!affirmativeSalesHiring('Engineers previously had to join our sales organization.', 'Skopenow'))
})
test('another company inviting people to join its sales team is not the lead hiring (Qodo)', () => {
  assert.ok(!affirmativeSalesHiring('Othercorp is looking for people to join our sales team.', 'Acmecorp'))
  assert.ok(affirmativeSalesHiring('Acmecorp is looking for people to join our sales team.', 'Acmecorp'))
})
