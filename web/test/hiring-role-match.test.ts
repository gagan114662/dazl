import test from 'node:test'
import assert from 'node:assert/strict'
import { requestedHiringRoles, matchedHiringRole } from '../lib/scan/hiring-role-match.ts'
const roles = requestedHiringRoles('B2B companies currently hiring a sales operations manager or CRM administrator (job posts on their own careers page)')
test('named hiring roles come from request/signals, not buyer personas', () => {
  assert.deepEqual(roles.map(r => r.term), ['sales operations manager', 'CRM administrator'])
  assert.deepEqual(requestedHiringRoles('Find companies hiring sales staff', JSON.stringify({ who: ['CRM Administrator'] })), [])
})
test('bounded title synonyms, no adjacent-role or broad-GTM equivalence', () => {
  assert.equal(matchedHiringRole('Senior Sales Ops Manager', roles)?.term, 'sales operations manager')
  assert.equal(matchedHiringRole('CRM Admin', roles)?.term, 'CRM administrator')
  for (const title of ['Account Executive', 'Associate Business Systems Administrator', 'Salesforce Developer', 'Sales Operations Analyst', 'CRM Manager']) assert.equal(matchedHiringRole(title, roles), null, title)
})

test('unsupported explicit title stays required instead of falling through to generic GTM', () => {
  const required = requestedHiringRoles('Companies hiring a quantum operations navigator')
  assert.equal(required.length, 1)
  assert.equal(matchedHiringRole('Account Executive', required), null)
})

test('qualifier-led, time, quantity and activity captures are not roles; quantity prefixes strip to the title', () => {
  for (const q of ['roofers hiring in the last 3 months', 'Find Ohio companies hiring in Dayton', 'agencies hiring now', 'firms hiring within 90 days', 'roofing crews hiring prospecting', 'Find Ohio companies that are hiring.'])
    assert.deepEqual(requestedHiringRoles(q, null), [], q)
  assert.deepEqual(requestedHiringRoles('Find dental practices hiring 2-3 receptionists.', null).map(r => r.term), ['receptionists'])
  assert.deepEqual(requestedHiringRoles('Find practices hiring one or two receptionists.', null).map(r => r.term), ['receptionists'])
  assert.deepEqual(requestedHiringRoles('startups hiring their first sales representative in the last 90 days', null).map(r => r.term), ['sales representative'])
})
