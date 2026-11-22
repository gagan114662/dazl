// #533 / #1205 live check (prod 37d46761, job fbaf13daab0953fc2aa1a9c3): "posted a front desk receptionist job" was not read as a hiring request,
// a Job Bank market-report page was cited as the posting, and a "treatment coordinator" posting was stretched to front desk.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requestedHiringRoles } from '../lib/scan/hiring-role-match.ts'
import { salesHiringRequired } from '../lib/scan/sales-hiring-required.ts'
import { isAggregateJobPage, namesRequestedRole, hiringPostingVerdict } from '../lib/scan/hiring-posting-check.ts'
import { hiringTimingLine, HIRING_NOT_BUYING } from '../lib/signals/hiring-timing-line.ts'
import { RESEARCH_REASONS, REVIEWABLE } from '../lib/lead-state.ts'

const Q = 'Find independent dental practices in London, Ontario that posted a front desk receptionist job in the past 90 days.'

test('#533 "posted a <role> job" names the requested posting title', () => {
  assert.deepEqual(requestedHiringRoles(Q).map(r => r.term), ['front desk receptionist'])
  assert.deepEqual(requestedHiringRoles('Bakeries that posted an opening for staff').map(r => r.term), [])
  assert.deepEqual(requestedHiringRoles('Agencies that posted a job recently').map(r => r.term), [])
  assert.deepEqual(requestedHiringRoles('SaaS companies that recently posted an SDR role').map(r => r.normalized), ['sdr'])
  assert.equal(salesHiringRequired('SaaS companies that recently posted an SDR role', null), true, 'a posted sales title needs the sales-hiring proof')
  assert.equal(salesHiringRequired(Q, null), false, 'a non-GTM posted title never needs the sales-hiring proof')
  assert.deepEqual(requestedHiringRoles('Firms hiring a paralegal').map(r => r.term), ['paralegal'], 'the hiring form is unchanged')
})

test('#1205/#533 an aggregate page is never a posting; a specific posting is', () => {
  for (const u of ['https://www.jobbank.gc.ca/marketreport/jobs/24390/geo27234', 'https://example.org/jobs/search?q=receptionist', 'https://board.example/browse/dental',
    'https://site.example/salary/receptionist', 'https://careers.example/results?keywords=receptionist', 'https://x.example/market-report/2026'])
    assert.equal(isAggregateJobPage(u), true, u)
  for (const u of ['https://boards.greenhouse.io/acme/jobs/123', 'https://www.jobbank.gc.ca/jobsearch/jobposting/44012345', 'https://acmedental.example/careers/front-desk-receptionist', 'not a url'])
    assert.equal(isAggregateJobPage(u), false, u)
})

test('#533 a posting for another role is off-role; qualifiers on the same role still match', () => {
  const roles = requestedHiringRoles(Q)
  assert.equal(namesRequestedRole('Posted a dental receptionist job', roles), true)
  assert.equal(namesRequestedRole('Hiring receptionists for the front office', roles), true)
  assert.equal(namesRequestedRole('Posted a dental treatment coordinator job', roles), false)
  const base = { source_url: 'https://acme.example/careers/42', excerpt: null }
  assert.deepEqual(hiringPostingVerdict({ ...base, signal: 'x' }, roles, { pageTitle: 'Dental Treatment Coordinator - Acme Dental' }), { ok: false, reason: 'job_role_mismatch' })
  assert.deepEqual(hiringPostingVerdict({ ...base, signal: 'x' }, roles, { pageTitle: 'Dental Receptionist - Acme Dental' }), { ok: true })
  assert.deepEqual(hiringPostingVerdict({ source_url: 'https://www.jobbank.gc.ca/marketreport/jobs/24390/geo27234', signal: 'Posted a dental receptionist job', excerpt: null }, roles), { ok: false, reason: 'posting_not_specific' })
  assert.deepEqual(hiringPostingVerdict({ ...base, signal: 'Hiring a dental hygienist' }, []), { ok: true }, 'no requested role: no role gate')
})

test('#533 the two holds are research holds a confirmation cannot clear', () => {
  for (const r of ['posting_not_specific', 'job_role_mismatch']) { assert.ok(RESEARCH_REASONS.has(r), r); assert.ok(!REVIEWABLE.has(r), r) }
})

test('#533 a hiring signal carries the "not proof they will buy" line; other signals do not', () => {
  assert.equal(hiringTimingLine('Posted a dental receptionist job'), HIRING_NOT_BUYING)
  assert.equal(hiringTimingLine('Hiring a Head of Sales'), HIRING_NOT_BUYING)
  assert.equal(hiringTimingLine('Raised a $5M seed round'), null)
  assert.equal(hiringTimingLine(null), null)
})

test('#533 a posted list of titles is several titles', () => {
  assert.deepEqual(requestedHiringRoles('Ohio companies that recently posted a payroll, HR or office manager job').map(r => r.term), ['payroll', 'HR', 'office manager'])
})

// Qodo review of #1510 (High 1, Mediums 2, 3, 4, 6)
test('Qodo H1: the posting title decides; a requested role mentioned in the description or the model signal does not', () => {
  const roles = requestedHiringRoles(Q), base = { source_url: 'https://acme.example/careers/42' }
  const desc = 'Acme Dental is hiring a treatment coordinator who will work alongside our front desk receptionist.'
  assert.deepEqual(hiringPostingVerdict({ ...base, signal: 'Hiring a front desk receptionist', excerpt: desc }, roles, { boardTitle: 'Treatment Coordinator' }), { ok: false, reason: 'job_role_mismatch' })
  assert.deepEqual(hiringPostingVerdict({ ...base, signal: 'Hiring a front desk receptionist', excerpt: desc }, roles, { pageTitle: 'Careers' }), { ok: false, reason: 'job_role_mismatch' }, 'the receptionist is only mentioned, not hired')
  assert.deepEqual(hiringPostingVerdict({ ...base, signal: 'Hiring a front desk receptionist', excerpt: null }, roles), { ok: false, reason: 'job_role_mismatch' }, 'the model signal alone never establishes the role')
  assert.deepEqual(hiringPostingVerdict({ ...base, signal: 'x', excerpt: 'Acme Dental is hiring a dental receptionist to greet patients.' }, roles, { pageTitle: 'Job' }), { ok: true }, 'a generic title: the quote states the vacancy')
  assert.deepEqual(hiringPostingVerdict({ ...base, signal: 'x', excerpt: 'Front desk receptionist position, full time.' }, roles, { pageTitle: 'Job' }), { ok: true })
  assert.deepEqual(hiringPostingVerdict({ ...base, signal: 'x', excerpt: desc }, roles, { boardTitle: 'Dental Receptionist' }), { ok: true })
})

test('Qodo M2: a mixed sales + other request still holds a posting naming neither', () => {
  const roles = requestedHiringRoles('Clinics hiring an SDR or receptionist')
  assert.ok(roles.length >= 2)
  assert.deepEqual(hiringPostingVerdict({ source_url: 'https://a.example/jobs/1', signal: 'x' }, roles, { boardTitle: 'Treatment Coordinator' }), { ok: false, reason: 'job_role_mismatch' })
  assert.deepEqual(hiringPostingVerdict({ source_url: 'https://a.example/jobs/1', signal: 'x' }, roles, { boardTitle: 'Receptionist' }), { ok: true })
  assert.deepEqual(hiringPostingVerdict({ source_url: 'https://a.example/jobs/1', signal: 'x' }, roles, { boardTitle: 'Sales Development Representative' }), { ok: true }, 'the sales title is left to the sales gate')
})

test('Qodo M3: a title-only signal stored as hiring carries the caution', () => {
  assert.equal(hiringTimingLine('Front desk receptionist job', 'hiring'), HIRING_NOT_BUYING)
  assert.equal(hiringTimingLine('Front desk receptionist', 'hiring'), HIRING_NOT_BUYING)
  assert.equal(hiringTimingLine('Opened a second clinic', 'expansion'), null)
})

test('Qodo M4: office manager is not sales manager; a qualifier on the same role still matches', () => {
  const roles = requestedHiringRoles('Ohio firms hiring an office manager')
  assert.equal(namesRequestedRole('Sales Manager', roles), false)
  assert.equal(namesRequestedRole('Dental Office Manager', roles), true)
  assert.equal(namesRequestedRole('Office Manager (part time)', roles), true)
})

test('Qodo M6: "posted a job for a <role>" names the role, and an unrelated posting is then held', () => {
  const roles = requestedHiringRoles('Clinics that posted a job for a front desk receptionist in the last month')
  assert.deepEqual(roles.map(r => r.term), ['front desk receptionist'])
  assert.deepEqual(requestedHiringRoles('Shops that posted a job for staff').map(r => r.term), [])
  assert.deepEqual(hiringPostingVerdict({ source_url: 'https://a.example/jobs/2', signal: 'x' }, roles, { boardTitle: 'Hygienist' }), { ok: false, reason: 'job_role_mismatch' })
})
