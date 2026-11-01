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
